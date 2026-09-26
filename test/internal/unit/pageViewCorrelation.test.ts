// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { NavigationInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { afterEach, expect, it, vi } from "vitest";
import { useMicrosoftOpenTelemetry } from "../../../src/useMicrosoftOpenTelemetry.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/types.js";
import { logToEnvelope } from "../../../src/exporter/logUtils.js";
import { spanToEnvelope } from "../../../src/exporter/spanUtils.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

const originalUrl = location.href;
const originalPush = history.pushState;
const originalReplace = history.replaceState;
let handle: MicrosoftOpenTelemetryBrowser | undefined;

afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
  history.pushState = originalPush;
  history.replaceState = originalReplace;
  history.replaceState(null, "", originalUrl);
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  vi.restoreAllMocks();
});

async function start(options: MicrosoftOpenTelemetryBrowserOptions = {}) {
  const pipeline = createInMemoryPipeline();
  const onLog = vi.spyOn(pipeline.logProcessor, "onEmit");
  const onSpan = vi.spyOn(pipeline.spanProcessor, "onStart");
  handle = await useMicrosoftOpenTelemetry({ ...pipeline.options, ...options });
  return {
    ...pipeline,
    onLog,
    onSpan,
    tracer: trace.getTracer("test"),
    logger: logs.getLogger("test"),
  };
}

it.each([false, true])(
  "uses one operation ID for the page, logs, spans and propagation (eager navigation=%s)",
  async (enabled) => {
    const navigation = new NavigationInstrumentation({ enabled });
    const pipeline = await start({
      instrumentations: [navigation],
      pageView: { sanitizeUrl: (url) => new URL(url).pathname },
    });
    const ids: string[] = [];
    for (const path of ["/checkout", "/confirmation"]) {
      history.pushState(null, "", path);
      const span = pipeline.tracer.startSpan(path);
      span.end();
      const id = span.spanContext().traceId;
      ids.push(id);
      pipeline.logger.emit({ body: path });
      const log = pipeline.onLog.mock.calls.at(-1)![0];
      const headers: Record<string, string> = {};
      propagation.inject(trace.setSpan(context.active(), span), headers);
      expect(headers.traceparent?.split("-")[1]).toBe(id);
      expect(log.spanContext?.traceId).toBe(id);
      expect(log.attributes).toEqual({});
      expect(pipeline.onSpan.mock.calls.at(-1)![0].attributes).toEqual({});
      const routeLog = pipeline.onLog.mock.calls.find(
        ([record]) =>
          record.eventName === "browser.navigation" &&
          record.attributes["url.full"] === location.href,
      )![0];
      expect(routeLog.spanContext?.traceId).toBe(id);
      window.dispatchEvent(new Event("pagehide"));
      const page = pipeline.onLog.mock.calls.find(
        ([record]) =>
          record.eventName === "browser.page_view" &&
          record.attributes["browser.page_view.id"] === id,
      )![0];
      const envelope = logToEnvelope(page, "key");
      expect(envelope.tags["ai.operation.id"]).toBe(id);
      expect(envelope.data).toMatchObject({
        baseType: "PageViewData",
        baseData: { id, url: path },
      });
      expect(logToEnvelope(log, "key").tags["ai.operation.id"]).toBe(id);
    }
    expect(ids[0]).not.toBe(ids[1]);
    await pipeline.spanProcessor.forceFlush();
    expect(
      pipeline.spanExporter
        .getFinishedSpans()
        .map((span) => spanToEnvelope(span, "key").tags["ai.operation.id"]),
    ).toEqual(ids);
  },
);

it("preserves explicit contexts and in-flight spans across navigation with a custom manager", async () => {
  const manager = new StackContextManager();
  const enabled = vi.spyOn(manager, "enable");
  const pipeline = await start({ traces: { contextManager: manager } });
  const parent = pipeline.tracer.startSpan("in-flight");
  const original = parent.spanContext();
  const bound = context.bind(trace.setSpan(ROOT_CONTEXT, parent), () => {
    pipeline.logger.emit({ body: "old operation" });
    const child = pipeline.tracer.startSpan("child");
    expect(child.spanContext().traceId).toBe(original.traceId);
    child.end();
  });
  history.pushState(null, "", "/new");
  bound();
  expect(pipeline.onLog.mock.calls.at(-1)![0].spanContext).toEqual(original);
  pipeline.logger.emit({ body: "new operation" });
  expect(pipeline.onLog.mock.calls.at(-1)![0].spanContext?.traceId).not.toBe(original.traceId);
  parent.end();
  expect(parent.spanContext()).toEqual(original);
  expect(enabled).toHaveBeenCalledOnce();
});

it("defaults the first page-view ID to an existing application operation", async () => {
  const existing = {
    traceId: "12345678901234567890123456789012",
    spanId: "1234567890123456",
    traceFlags: 0,
  };
  const manager = new StackContextManager();
  vi.spyOn(manager, "active").mockReturnValue(trace.setSpanContext(ROOT_CONTEXT, existing));
  const pipeline = await start({ traces: { contextManager: manager } });
  window.dispatchEvent(new Event("pagehide"));
  const page = pipeline.onLog.mock.calls.find(
    ([record]) => record.eventName === "browser.page_view",
  )![0];
  expect(page.spanContext).toEqual(existing);
  expect(page.attributes["browser.page_view.id"]).toBe(existing.traceId);
});

it("keeps a delayed page event's original operation in logs-only mode", async () => {
  const pipeline = await start({
    spanProcessors: [],
    pageView: {
      applyCustomLogRecordData: (record) => {
        if (record.attributes?.["browser.page_view.index"] === 0)
          history.pushState(null, "", "/next");
      },
    },
  });
  pipeline.logger.emit({ body: "before" });
  const first = pipeline.onLog.mock.calls.at(-1)![0].spanContext!.traceId;
  window.dispatchEvent(new Event("pagehide"));
  const page = pipeline.onLog.mock.calls.find(
    ([record]) =>
      record.eventName === "browser.page_view" &&
      record.attributes["browser.page_view.index"] === 0,
  )![0];
  expect(page.spanContext?.traceId).toBe(first);
  expect(page.attributes["browser.page_view.id"]).toBe(first);
  pipeline.logger.emit({ body: "after" });
  expect(pipeline.onLog.mock.calls.at(-1)![0].spanContext?.traceId).not.toBe(first);
});

it("keeps correlation disabled when page views are off, and stops it at shutdown", async () => {
  const disabled = await start({ pageView: { enabled: false } });
  disabled.logger.emit({ body: "no page" });
  expect(disabled.onLog.mock.calls.at(-1)![0].spanContext).toBeUndefined();
  await handle!.shutdown();
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  const enabled = await start();
  const pageId = trace.getSpanContext(context.active())!.traceId;
  const stopping = handle!.shutdown();
  expect(trace.getSpanContext(context.active())).toBeUndefined();
  const late = enabled.tracer.startSpan("late");
  expect(late.spanContext().traceId).not.toBe(pageId);
  late.end();
  await stopping;
});

it("does not bypass caller log filtering or disabled signal arrays", async () => {
  const onEmit = vi.fn();
  handle = await useMicrosoftOpenTelemetry({
    spanProcessors: [],
    logRecordProcessors: [
      {
        enabled: () => false,
        onEmit,
        forceFlush: async () => {},
        shutdown: async () => {},
      },
    ],
  });
  logs.getLogger("filtered").emit({ body: "rejected" });
  expect(onEmit).not.toHaveBeenCalled();
  expect(trace.getSpanContext(context.active())).toBeUndefined();
});
