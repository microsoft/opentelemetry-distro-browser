// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { startLogsSdk } from "@opentelemetry/browser-sdk/logs";
import { startTracesSdk } from "@opentelemetry/browser-sdk/traces";
import { afterEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  useMicrosoftOpenTelemetryLogs,
  useMicrosoftOpenTelemetryTraces,
  type MicrosoftOpenTelemetryBrowser,
} from "../../../src/index.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

const handles = new Set<MicrosoftOpenTelemetryBrowser>();

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

it("exports the upstream initializers directly, without lifecycle wrappers", () => {
  expect(useMicrosoftOpenTelemetry).toBe(startBrowserSdk);
  expect(useMicrosoftOpenTelemetryLogs).toBe(startLogsSdk);
  expect(useMicrosoftOpenTelemetryTraces).toBe(startTracesSdk);
});

it.each([
  { name: "combined", initialize: useMicrosoftOpenTelemetry },
  { name: "traces", initialize: useMicrosoftOpenTelemetryTraces },
  { name: "logs", initialize: useMicrosoftOpenTelemetryLogs },
])(
  "delegates the disabled $name configuration without registering providers",
  async ({ initialize }) => {
    const registerTrace = vi.spyOn(trace, "setGlobalTracerProvider");
    const registerLogs = vi.spyOn(logs, "setGlobalLoggerProvider");
    const handle = initialize({ disabled: true });
    handles.add(handle);
    expect(registerTrace).not.toHaveBeenCalled();
    expect(registerLogs).not.toHaveBeenCalled();
    expect(handle).not.toHaveProperty("forceFlush");
    await handle.shutdown();
  },
);

it("exports correlated manual telemetry with upstream resources and processors", async () => {
  const pipeline = createInMemoryPipeline();
  const spanExport = vi.spyOn(pipeline.spanExporter, "export");
  const logExport = vi.spyOn(pipeline.logExporter, "export");
  const handle = useMicrosoftOpenTelemetry({
    ...pipeline.options,
    serviceName: "checkout",
    resourceAttributes: { "test.resource": true },
  });
  handles.add(handle);
  const span = trace.getTracer("manual", "1.2.3").startSpan("checkout");
  logs.getLogger("manual", "1.2.3").emit({
    eventName: "checkout.started",
    context: trace.setSpan(ROOT_CONTEXT, span),
  });
  span.end();
  await handle.shutdown();

  const exportedSpan = spanExport.mock.calls[0][0][0];
  const exportedLog = logExport.mock.calls[0][0][0];
  expect(exportedSpan.name).toBe("checkout");
  expect(exportedLog.eventName).toBe("checkout.started");
  expect(exportedLog.spanContext).toEqual(span.spanContext());
  for (const record of [exportedSpan, exportedLog]) {
    expect(record.resource.attributes).toMatchObject({
      "service.name": "checkout",
      "test.resource": true,
    });
    expect(record.instrumentationScope).toMatchObject({ name: "manual", version: "1.2.3" });
  }
});

it.each(["traces", "logs"] as const)(
  "initializes only %s and leaves the other signal's global untouched",
  async (signal) => {
    const pipeline = createInMemoryPipeline();
    const originalTrace = trace.getTracerProvider();
    const originalLogs = logs.getLoggerProvider();
    const spanExport = vi.spyOn(pipeline.spanExporter, "export");
    const logExport = vi.spyOn(pipeline.logExporter, "export");
    const handle =
      signal === "traces"
        ? useMicrosoftOpenTelemetryTraces(pipeline.options.traces)
        : useMicrosoftOpenTelemetryLogs(pipeline.options.logs);
    handles.add(handle);
    trace.getTracer("manual").startSpan("trace").end();
    logs.getLogger("manual").emit({ eventName: "log" });
    await handle.shutdown();
    if (signal === "traces") {
      expect(spanExport.mock.calls[0][0][0].name).toBe("trace");
      expect(logExport).not.toHaveBeenCalled();
      expect(logs.getLoggerProvider()).toBe(originalLogs);
    } else {
      expect(logExport.mock.calls[0][0][0].eventName).toBe("log");
      expect(spanExport).not.toHaveBeenCalled();
      expect(trace.getTracerProvider()).toBe(originalTrace);
    }
  },
);

it("preserves an upstream shutdown rejection", async () => {
  const failure = new Error("processor shutdown failed");
  const handle = useMicrosoftOpenTelemetryLogs({
    processors: [
      {
        onEmit() {},
        async forceFlush() {},
        async shutdown() {
          throw failure;
        },
      },
    ],
  });
  await expect(handle.shutdown()).rejects.toBe(failure);
});
