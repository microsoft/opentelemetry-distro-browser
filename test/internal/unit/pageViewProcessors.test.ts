// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  context,
  diag,
  propagation,
  trace,
  ROOT_CONTEXT,
  type Attributes,
  type SpanContext,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { afterEach, expect, it, vi } from "vitest";
import { useMicrosoftOpenTelemetry } from "../../../src/useMicrosoftOpenTelemetry.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/types.js";
import { PageViewInstrumentation } from "../../../src/instrumentation/pageView/pageViewInstrumentation.js";
import { PageViewContextManager } from "../../../src/instrumentation/pageView/pageViewContextManager.js";
import { PageViewLogRecordProcessor } from "../../../src/instrumentation/pageView/pageViewProcessors.js";
import { EVENT_BROWSER_PAGE_VIEW } from "../../../src/instrumentation/pageView/semconv.js";
import { logToEnvelope } from "../../../src/exporter/logUtils.js";
import { spanToEnvelope } from "../../../src/exporter/spanUtils.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

const originalUrl = location.href;
const handles = new Set<MicrosoftOpenTelemetryBrowser>();

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
  history.replaceState(null, "", originalUrl);
  for (const result of results) if (result.status === "rejected") throw result.reason;
});

async function initialize(options: MicrosoftOpenTelemetryBrowserOptions = {}) {
  const pipeline = createInMemoryPipeline();
  const onStart = vi.spyOn(pipeline.spanProcessor, "onStart");
  const onEmit = vi.spyOn(pipeline.logProcessor, "onEmit");
  const handle = await useMicrosoftOpenTelemetry({ ...pipeline.options, ...options });
  handles.add(handle);
  const tracer = trace.getTracer("page-operation");
  const logger = logs.getLogger("page-operation");
  function emit(attributes: Attributes = {}) {
    tracer.startSpan("manual", { attributes }).end();
    logger.emit({ eventName: "manual", attributes });
    return [onStart.mock.calls.at(-1)![0], onEmit.mock.calls.at(-1)![0]] as const;
  }
  return { ...pipeline, onStart, onEmit, handle, tracer, logger, emit };
}

it("shares one native operation and page-view ID without stamping page metadata on other telemetry", async () => {
  history.replaceState(null, "", "/initial?secret=one");
  const pipeline = await initialize({
    pageView: { sanitizeUrl: (url) => new URL(url).pathname, routeResolver: () => "/route/:id" },
  });
  const attributes = { "url.full": "https://api.example/orders/123", custom: "kept" };
  const [span, log] = pipeline.emit(attributes);
  const id = span.spanContext().traceId;
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(log.spanContext?.traceId).toBe(id);
  expect(pipeline.emit()[0].spanContext().traceId).toBe(id);
  expect(span.attributes).toEqual(attributes);
  expect(log.attributes).toEqual(attributes);
  window.dispatchEvent(new Event("pagehide"));
  const page = pipeline.onEmit.mock.calls.find(
    ([r]) => r.eventName === EVENT_BROWSER_PAGE_VIEW,
  )![0];
  expect(page.spanContext?.traceId).toBe(id);
  expect(page.attributes).toMatchObject({
    "browser.page_view.id": id,
    "browser.page_view.name": "/route/:id",
    "url.full": "/initial",
  });
  expect(page.attributes["browser.document.url.full"]).toBeUndefined();
  const pageEnvelope = logToEnvelope(page, "key");
  expect(pageEnvelope.data).toMatchObject({
    baseType: "PageViewData",
    baseData: { id, name: "/route/:id", url: "/initial" },
  });
  await pipeline.spanProcessor.forceFlush();
  const spanEnvelope = spanToEnvelope(pipeline.spanExporter.getFinishedSpans()[0], "key");
  for (const envelope of [pageEnvelope, spanEnvelope, logToEnvelope(log, "key")]) {
    expect(envelope.tags["ai.operation.id"]).toBe(id);
  }
});

it("rotates operations on navigation without rewriting in-flight spans or explicitly bound callbacks", async () => {
  const pipeline = await initialize();
  const first = pipeline.tracer.startSpan("in-flight");
  const firstContext = trace.setSpan(context.active(), first);
  const bound = context.bind(firstContext, () => pipeline.emit());
  const id = first.spanContext().traceId;
  history.pushState(null, "", "/next");
  const [next, nextLog] = pipeline.emit();
  expect(next.spanContext().traceId).not.toBe(id);
  expect(nextLog.spanContext?.traceId).toBe(next.spanContext().traceId);
  const [oldChild, oldLog] = bound();
  expect(oldChild.spanContext().traceId).toBe(id);
  expect(oldChild.parentSpanContext?.spanId).toBe(first.spanContext().spanId);
  expect(oldLog.spanContext).toEqual(first.spanContext());
  first.end();
  await pipeline.spanProcessor.forceFlush();
  expect(
    pipeline.spanExporter
      .getFinishedSpans()
      .find((s) => s.name === "in-flight")
      ?.spanContext().traceId,
  ).toBe(id);
});

it("preserves explicit trace contexts, sampling flags, baggage, and explicitly rooted spans", async () => {
  const delegate = new StackContextManager();
  const enabled = vi.spyOn(delegate, "enable");
  const withContext = vi.spyOn(delegate, "with");
  const pipeline = await initialize({ traces: { contextManager: delegate } });
  const pageId = pipeline.emit()[0].spanContext().traceId;
  const explicit: SpanContext = {
    traceId: "12345678901234567890123456789012",
    spanId: "1234567890123456",
    traceFlags: 0,
    isRemote: true,
  };
  const supplied = trace.setSpanContext(ROOT_CONTEXT, explicit);
  const baggage = propagation.createBaggage({ tenant: { value: "example" } });
  context.with(propagation.setBaggage(supplied, baggage), () => {
    expect(trace.getSpanContext(context.active())).toEqual(explicit);
    expect(propagation.getBaggage(context.active())?.getEntry("tenant")?.value).toBe("example");
    const child = pipeline.tracer.startSpan("explicit-child");
    expect(child.spanContext().traceId).toBe(explicit.traceId);
    expect(child.spanContext().traceFlags).toBe(0);
    child.end();
    pipeline.logger.emit({ body: "explicit log" });
  });
  expect(pipeline.onEmit.mock.calls.at(-1)![0].spanContext).toEqual(explicit);
  const root = pipeline.tracer.startSpan("root", { root: true });
  expect(root.spanContext().traceId).not.toBe(pageId);
  root.end();
  expect(enabled).toHaveBeenCalledOnce();
  expect(withContext).toHaveBeenCalled();
});

it("uses an existing initial operation rather than generating an unrelated page ID", async () => {
  const initial: SpanContext = {
    traceId: "12345678901234567890123456789012",
    spanId: "1234567890123456",
    traceFlags: 1,
  };
  const initialContext = trace.setSpanContext(ROOT_CONTEXT, initial);
  const delegate = new StackContextManager();
  vi.spyOn(delegate, "active").mockReturnValue(initialContext);
  const { onEmit } = await initialize({ traces: { contextManager: delegate } });
  window.dispatchEvent(new Event("pagehide"));
  const page = onEmit.mock.calls.find(([r]) => r.eventName === EVENT_BROWSER_PAGE_VIEW)![0];
  expect(page.attributes["browser.page_view.id"]).toBe(initial.traceId);
  expect(page.spanContext).toEqual(initial);
});

it.each([false, true])(
  "retains a delayed page view's operation across navigation (logs only=%s)",
  async (logsOnly) => {
    const pipeline = await initialize({
      ...(logsOnly ? { spanProcessors: [] } : {}),
      pageView: {
        applyCustomLogRecordData: (record) => {
          if (record.attributes?.["browser.page_view.index"] === 0) {
            record.attributes["browser.page_view.name"] = "hook-name";
            history.pushState(null, "", "/during-emission");
          }
        },
      },
    });
    pipeline.logger.emit({ body: "before navigation" });
    const originalId = pipeline.onEmit.mock.calls.at(-1)![0].spanContext!.traceId;
    window.dispatchEvent(new Event("pagehide"));
    const page = pipeline.onEmit.mock.calls.find(
      ([r]) => r.eventName === EVENT_BROWSER_PAGE_VIEW,
    )![0];
    expect(page.spanContext?.traceId).toBe(originalId);
    expect(page.attributes["browser.page_view.id"]).toBe(originalId);
    expect(page.attributes["browser.page_view.name"]).toBe("hook-name");
    pipeline.logger.emit({ body: "after navigation" });
    expect(pipeline.onEmit.mock.calls.at(-1)![0].spanContext?.traceId).not.toBe(originalId);
  },
);

it.each([undefined, "", "custom-page-id"])(
  "correlates a manually emitted page view in logs-only mode (ID %j)",
  async (id) => {
    const pipeline = await initialize({ spanProcessors: [] });
    const attributes = id === undefined ? {} : { "browser.page_view.id": id };
    pipeline.logger.emit({ eventName: EVENT_BROWSER_PAGE_VIEW, attributes });
    const manual = pipeline.onEmit.mock.calls.at(-1)![0];
    window.dispatchEvent(new Event("pagehide"));
    const collected = pipeline.onEmit.mock.calls.find(
      ([record]) => record.attributes["browser.page_view.index"] === 0,
    )![0];
    const operationId = collected.spanContext!.traceId;
    expect(manual.spanContext?.traceId).toBe(operationId);
    expect(manual.attributes).toEqual(attributes);
    const envelope = logToEnvelope(manual, "key");
    expect(envelope.tags["ai.operation.id"]).toBe(operationId);
    expect(envelope.data.baseData).toMatchObject({ id: id || operationId });
  },
);

it("correlates logs and page views with traces disabled without installing a context manager", async () => {
  const registerContext = vi.spyOn(context, "setGlobalContextManager");
  const pipeline = await initialize({ spanProcessors: [] });
  pipeline.logger.emit({ body: "log-only" });
  const log = pipeline.onEmit.mock.calls.at(-1)![0];
  window.dispatchEvent(new Event("pagehide"));
  const page = pipeline.onEmit.mock.calls.find(
    ([r]) => r.eventName === EVENT_BROWSER_PAGE_VIEW,
  )![0];
  expect(log.spanContext?.traceId).toBe(page.attributes["browser.page_view.id"]);
  expect(log.attributes).toEqual({});
  expect(registerContext).not.toHaveBeenCalled();
});

it("provides the page operation before caller instrumentations emit during enable", async () => {
  let startupId: string | undefined;
  const pipeline = await initialize({
    instrumentations: [
      {
        getConfig: () => ({ enabled: false }),
        setTracerProvider: () => {},
        enable: () => {
          const span = trace.getTracer("startup").startSpan("startup");
          startupId = span.spanContext().traceId;
          span.end();
        },
        disable: () => {},
      },
    ],
  });
  expect(pipeline.emit()[0].spanContext().traceId).toBe(startupId);
});

it("includes the page-view record in the automatic pagehide flush", async () => {
  const pipeline = await initialize();
  const flush = vi.spyOn(pipeline.logProcessor, "forceFlush");
  window.dispatchEvent(new Event("pagehide"));
  await Promise.resolve();
  expect(flush).toHaveBeenCalledOnce();
  await flush.mock.results[0].value;
  expect(pipeline.logExporter.getFinishedLogRecords()).toContainEqual(
    expect.objectContaining({ eventName: EVENT_BROWSER_PAGE_VIEW }),
  );
});

it("flushes a page view when pagehide follows an in-flight visibility flush", async () => {
  const pipeline = await initialize();
  const originalExport = pipeline.logExporter.export.bind(pipeline.logExporter);
  let release!: () => void;
  const exporting = new Promise<void>((resolve) => {
    vi.spyOn(pipeline.logExporter, "export").mockImplementationOnce((records, callback) => {
      release = () => originalExport(records, callback);
      resolve();
    });
  });
  pipeline.logger.emit({ body: "before hiding" });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  await exporting;
  try {
    window.dispatchEvent(new Event("pagehide"));
  } finally {
    release();
  }
  await vi.waitFor(
    () =>
      expect(pipeline.logExporter.getFinishedLogRecords()).toContainEqual(
        expect.objectContaining({ eventName: EVENT_BROWSER_PAGE_VIEW }),
      ),
    { timeout: 300 },
  );
});

it("does not correlate by page when page views are disabled", async () => {
  const { emit } = await initialize({ pageView: { enabled: false } });
  const [first, log] = emit();
  expect(emit()[0].spanContext().traceId).not.toBe(first.spanContext().traceId);
  expect(log.spanContext).toBeUndefined();
  expect(first.attributes).toEqual({});
  expect(log.attributes).toEqual({});
});

it("stops supplying the page operation immediately on shutdown", async () => {
  const { handle, spanProcessor, tracer, emit } = await initialize();
  const pageId = emit()[0].spanContext().traceId;
  let finish!: () => void;
  const originalShutdown = spanProcessor.shutdown.bind(spanProcessor);
  vi.spyOn(spanProcessor, "shutdown").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          void originalShutdown().then(resolve);
        };
      }),
  );
  const stopping = handle.shutdown();
  try {
    const stale = tracer.startSpan("stale");
    expect(stale.spanContext().traceId).not.toBe(pageId);
    stale.end();
    expect(trace.getSpanContext(context.active())).toBeUndefined();
  } finally {
    finish();
    await stopping;
  }
});

it("keeps log filtering unchanged and releases the log processor source on shutdown", async () => {
  const getPageView = vi.fn(() => undefined);
  const processor = new PageViewLogRecordProcessor(getPageView);
  const pipeline = await initialize({ pageView: { enabled: false } });
  const log = pipeline.emit()[1];
  processor.onEmit(log);
  expect(getPageView).toHaveBeenCalledOnce();
  expect(processor.enabled()).toBe(false);
  await processor.forceFlush();
  await processor.shutdown();
  getPageView.mockClear();
  processor.onEmit(log);
  expect(getPageView).not.toHaveBeenCalled();
});

it("disables and reenables its delegated context manager", async () => {
  let source: PageViewInstrumentation["pageViews"] | undefined;
  const enable = PageViewInstrumentation.prototype.enable;
  vi.spyOn(PageViewInstrumentation.prototype, "enable").mockImplementation(function (
    this: PageViewInstrumentation,
  ) {
    source = this.pageViews;
    enable.call(this);
  });
  await initialize();
  const delegate = new StackContextManager();
  const disable = vi.spyOn(delegate, "disable");
  const manager = new PageViewContextManager(() => source?.getCurrentPageView(), delegate);
  expect(manager.active()).toBe(ROOT_CONTEXT);
  manager.enable();
  expect(trace.getSpanContext(manager.active())?.traceId).toBe(source?.getCurrentPageView()?.id);
  manager.disable();
  expect(manager.active()).toBe(ROOT_CONTEXT);
  expect(disable).toHaveBeenCalledOnce();
  manager.enable();
  expect(trace.getSpanContext(manager.active())?.traceId).toBe(source?.getCurrentPageView()?.id);
  manager.shutdown();
  expect(manager.active()).toBe(ROOT_CONTEXT);
});

it("clears operation context and restores history when page-view startup fails", async () => {
  const pushState = history.pushState;
  const originalEnable = PageViewInstrumentation.prototype.enable;
  let pageViews: PageViewInstrumentation["pageViews"] | undefined;
  vi.spyOn(PageViewInstrumentation.prototype, "enable").mockImplementation(function (
    this: PageViewInstrumentation,
  ) {
    pageViews = this.pageViews;
    originalEnable.call(this);
    throw new Error("page startup failed");
  });
  const pipeline = createInMemoryPipeline();
  await expect(useMicrosoftOpenTelemetry(pipeline.options)).rejects.toThrow("page startup failed");
  expect(history.pushState).toBe(pushState);
  expect(pageViews?.getCurrentPageView()).toBeUndefined();
  expect(trace.getSpanContext(context.active())).toBeUndefined();
});
