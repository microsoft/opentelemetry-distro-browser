// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  browserDetector,
  userAgentDetector,
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

vi.mock("@opentelemetry/browser-sdk", { spy: true });

const handles = new Set<MicrosoftOpenTelemetryBrowser>();

beforeEach(() => {
  vi.mocked(startBrowserSdk).mockClear();
});

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  // Upstream shutdown does not unregister globals; isolate tests explicitly.
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

it("prepends session enrichment without changing the caller's processor arrays", async () => {
  const options: MicrosoftOpenTelemetryBrowserOptions = {
    session: { enabled: true },
    spanProcessors: [],
    logRecordProcessors: [],
  };
  const upstreamHandle = { shutdown: vi.fn(async () => {}) };
  vi.mocked(startBrowserSdk).mockReturnValueOnce(upstreamHandle);

  const handle = await useMicrosoftOpenTelemetry(Object.freeze(options));
  handles.add(handle);
  expect(useMicrosoftOpenTelemetry).not.toBe(startBrowserSdk);
  expect(startBrowserSdk).toHaveBeenCalledExactlyOnceWith({
    traces: { processors: [expect.objectContaining({ onStart: expect.any(Function) })] },
    logs: { processors: [expect.objectContaining({ onEmit: expect.any(Function) })] },
  });
  expect(options.spanProcessors).toEqual([]);
  expect(options.logRecordProcessors).toEqual([]);

  await handle.shutdown();
  expect(upstreamHandle.shutdown).toHaveBeenCalledOnce();
});

it("propagates initialization failures without returning a success-shaped handle", async () => {
  const failure = new Error("initialization failed");
  vi.mocked(startBrowserSdk).mockImplementationOnce(() => {
    throw failure;
  });
  await expect(useMicrosoftOpenTelemetry()).rejects.toThrow(failure);
});

it.each([undefined, {}])(
  "initializes both providers with default configuration %j",
  async (options) => {
    const registerTrace = vi.spyOn(trace, "setGlobalTracerProvider");
    const registerLogs = vi.spyOn(logs, "setGlobalLoggerProvider");
    const detectBrowser = vi.spyOn(browserDetector, "detect");
    const detectUserAgent = vi.spyOn(userAgentDetector, "detect");
    const handle = await useMicrosoftOpenTelemetry(options);
    handles.add(handle);
    expect(registerTrace).toHaveBeenCalledOnce();
    expect(registerLogs).toHaveBeenCalledOnce();
    expect(detectBrowser).not.toHaveBeenCalled();
    expect(detectUserAgent).not.toHaveBeenCalled();
  },
);

it("exports correlated manual telemetry through custom processors", async () => {
  const pipeline = createInMemoryPipeline();
  Object.freeze(pipeline.options.spanProcessors);
  Object.freeze(pipeline.options.logRecordProcessors);
  const spanExport = vi.spyOn(pipeline.spanExporter, "export");
  const logExport = vi.spyOn(pipeline.logExporter, "export");
  const handle = await useMicrosoftOpenTelemetry(Object.freeze(pipeline.options));
  handles.add(handle);
  const span = trace.getTracer("manual", "1.2.3").startSpan("checkout");
  logs.getLogger("manual", "1.2.3").emit({
    eventName: "checkout.started",
    context: trace.setSpan(ROOT_CONTEXT, span),
  });
  span.end();
  await handle.shutdown();
  handles.delete(handle);

  const exportedSpan = spanExport.mock.calls[0][0][0];
  const exportedLog = logExport.mock.calls[0][0][0];
  expect(exportedSpan.name).toBe("checkout");
  expect(exportedLog.eventName).toBe("checkout.started");
  expect(exportedLog.spanContext).toEqual(span.spanContext());
  for (const record of [exportedSpan, exportedLog]) {
    expect(record.instrumentationScope).toMatchObject({ name: "manual", version: "1.2.3" });
  }
  expect(pipeline.options.spanProcessors).toEqual([pipeline.spanProcessor]);
  expect(pipeline.options.logRecordProcessors).toEqual([pipeline.logProcessor]);
});

it.each([
  { enabled: true, processors: undefined },
  { enabled: true, processors: [] },
  { enabled: false, processors: undefined },
  { enabled: false, processors: [] },
])(
  "preserves default export versus explicit processor arrays (%j)",
  async ({ enabled, processors }) => {
    const spanExport = vi
      .spyOn(OTLPTraceExporter.prototype, "export")
      .mockImplementation((_spans, callback) => callback({ code: 0 }));
    const logExport = vi
      .spyOn(OTLPLogExporter.prototype, "export")
      .mockImplementation((_records, callback) => callback({ code: 0 }));
    const handle = await useMicrosoftOpenTelemetry({
      session: { enabled },
      spanProcessors: processors,
      logRecordProcessors: processors,
    });
    handles.add(handle);
    trace.getTracer("default-export").startSpan("default").end();
    logs.getLogger("default-export").emit({ eventName: "default" });
    await handle.shutdown();
    if (processors === undefined) {
      expect(spanExport).toHaveBeenCalledOnce();
      expect(logExport).toHaveBeenCalledOnce();
      const id = spanExport.mock.calls[0][0][0].attributes["session.id"];
      if (enabled) expect(id).toMatch(/^[0-9a-f]{32}$/);
      else expect(id).toBeUndefined();
      expect(logExport.mock.calls[0][0][0].attributes["session.id"]).toBe(id);
    } else {
      expect(spanExport).not.toHaveBeenCalled();
      expect(logExport).not.toHaveBeenCalled();
    }
  },
);

it("reports an upstream shutdown failure while shutting down both signals", async () => {
  const failure = new Error("processor shutdown failed");
  const pipeline = createInMemoryPipeline();
  const traceShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
  const handle = await useMicrosoftOpenTelemetry({
    spanProcessors: pipeline.options.spanProcessors,
    logRecordProcessors: [
      {
        onEmit() {},
        async forceFlush() {},
        async shutdown() {
          throw failure;
        },
      },
    ],
  });
  await expect(handle.shutdown()).rejects.toThrow("processor shutdown failed");
  expect(traceShutdown).toHaveBeenCalledOnce();
});
