// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { afterEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
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

it("exports the upstream combined initializer directly, without lifecycle wrappers", () => {
  expect(useMicrosoftOpenTelemetry).toBe(startBrowserSdk);
});

it("delegates the globally disabled configuration without registering providers", async () => {
  const registerTrace = vi.spyOn(trace, "setGlobalTracerProvider");
  const registerLogs = vi.spyOn(logs, "setGlobalLoggerProvider");
  const handle = useMicrosoftOpenTelemetry({ disabled: true });
  handles.add(handle);
  expect(registerTrace).not.toHaveBeenCalled();
  expect(registerLogs).not.toHaveBeenCalled();
  expect(handle).not.toHaveProperty("forceFlush");
  await handle.shutdown();
});

it("initializes both providers when signal configuration is omitted", async () => {
  const registerTrace = vi.spyOn(trace, "setGlobalTracerProvider");
  const registerLogs = vi.spyOn(logs, "setGlobalLoggerProvider");
  const handle = useMicrosoftOpenTelemetry();
  handles.add(handle);
  expect(registerTrace).toHaveBeenCalledOnce();
  expect(registerLogs).toHaveBeenCalledOnce();
  await handle.shutdown();
});

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

it("reports an upstream shutdown failure while shutting down both signals", async () => {
  const failure = new Error("processor shutdown failed");
  const pipeline = createInMemoryPipeline();
  const traceShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
  const handle = useMicrosoftOpenTelemetry({
    traces: pipeline.options.traces,
    logs: {
      processors: [
        {
          onEmit() {},
          async forceFlush() {},
          async shutdown() {
            throw failure;
          },
        },
      ],
    },
  });
  await expect(handle.shutdown()).rejects.toThrow("processor shutdown failed");
  expect(traceShutdown).toHaveBeenCalledOnce();
});
