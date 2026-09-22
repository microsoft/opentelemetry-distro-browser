// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
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

it("maps distro processors and returns the upstream handle unchanged", () => {
  const options: MicrosoftOpenTelemetryBrowserOptions = {
    spanProcessors: [],
    logRecordProcessors: [],
  };
  const upstreamHandle = { shutdown: vi.fn(async () => {}) };
  vi.mocked(startBrowserSdk).mockReturnValueOnce(upstreamHandle);

  expect(useMicrosoftOpenTelemetry(Object.freeze(options))).toBe(upstreamHandle);
  expect(useMicrosoftOpenTelemetry).not.toBe(startBrowserSdk);
  expect(startBrowserSdk).toHaveBeenCalledExactlyOnceWith({
    traces: { processors: options.spanProcessors },
    logs: { processors: options.logRecordProcessors },
  });
});

it("propagates initialization failures without returning a success-shaped handle", () => {
  const failure = new Error("initialization failed");
  vi.mocked(startBrowserSdk).mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => useMicrosoftOpenTelemetry()).toThrow(failure);
});

it.each([undefined, {}])("initializes both providers with default configuration %j", (options) => {
  const registerTrace = vi.spyOn(trace, "setGlobalTracerProvider");
  const registerLogs = vi.spyOn(logs, "setGlobalLoggerProvider");
  const detectBrowser = vi.spyOn(browserDetector, "detect");
  const detectUserAgent = vi.spyOn(userAgentDetector, "detect");
  const handle = useMicrosoftOpenTelemetry(options);
  handles.add(handle);
  expect(registerTrace).toHaveBeenCalledOnce();
  expect(registerLogs).toHaveBeenCalledOnce();
  expect(detectBrowser).not.toHaveBeenCalled();
  expect(detectUserAgent).not.toHaveBeenCalled();
});

it("exports correlated manual telemetry through custom processors", async () => {
  const pipeline = createInMemoryPipeline();
  const spanExport = vi.spyOn(pipeline.spanExporter, "export");
  const logExport = vi.spyOn(pipeline.logExporter, "export");
  const handle = useMicrosoftOpenTelemetry(Object.freeze(pipeline.options));
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
});

it("reports an upstream shutdown failure while shutting down both signals", async () => {
  const failure = new Error("processor shutdown failed");
  const pipeline = createInMemoryPipeline();
  const traceShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
  const handle = useMicrosoftOpenTelemetry({
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
