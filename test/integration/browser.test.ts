// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, expect, it, vi } from "vitest";
import minifiedBundle from "../../dist/esm/index.min.js?raw";
import { version } from "../../package.json";
import type { MicrosoftOpenTelemetryBrowser } from "../../src/index.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

afterEach(() => {
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
});

it("initializes the minified bundle as native browser ESM", async () => {
  const url = URL.createObjectURL(new Blob([minifiedBundle], { type: "text/javascript" }));
  let telemetry: MicrosoftOpenTelemetryBrowser | undefined;
  try {
    // Import the emitted bytes directly, without Vite transforming the module.
    const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url);
    expect(Object.keys(distro).sort()).toEqual([
      "OPENTELEMETRY_BROWSER_VERSION",
      "useMicrosoftOpenTelemetry",
      "useMicrosoftOpenTelemetryLogs",
      "useMicrosoftOpenTelemetryTraces",
    ]);
    expect(distro.OPENTELEMETRY_BROWSER_VERSION).toBe(version);
    expect(window).not.toHaveProperty("OpenTelemetryBrowser");
    const pipeline = createInMemoryPipeline();
    const processors = [pipeline.spanProcessor, pipeline.logProcessor];
    const shutdowns = processors.map((processor) => vi.spyOn(processor, "shutdown"));
    telemetry = distro.useMicrosoftOpenTelemetry(pipeline.options);
    expect(telemetry).not.toHaveProperty("forceFlush");
    await telemetry.shutdown();
    telemetry = undefined;
    for (const shutdown of shutdowns) expect(shutdown).toHaveBeenCalledOnce();
  } finally {
    await telemetry?.shutdown();
    URL.revokeObjectURL(url);
  }
});

it.each([
  { name: "useMicrosoftOpenTelemetry", traces: true, logs: true },
  { name: "useMicrosoftOpenTelemetryTraces", traces: true, logs: false },
  { name: "useMicrosoftOpenTelemetryLogs", traces: false, logs: true },
] as const)("exports manual telemetry through the built $name initializer", async (entry) => {
  // Type-check from a clean checkout; load the built artifact only at runtime.
  const url = new URL("../../dist/esm/index.js", import.meta.url);
  const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url.href);
  const pipeline = createInMemoryPipeline();
  const originalTrace = trace.getTracerProvider();
  const originalLogs = logs.getLoggerProvider();
  const tracer = trace.getTracer("browser-consumer");
  const logger = logs.getLogger("browser-consumer");
  const telemetry =
    entry.name === "useMicrosoftOpenTelemetry"
      ? distro.useMicrosoftOpenTelemetry(pipeline.options)
      : entry.name === "useMicrosoftOpenTelemetryTraces"
        ? distro.useMicrosoftOpenTelemetryTraces(pipeline.options.traces)
        : distro.useMicrosoftOpenTelemetryLogs(pipeline.options.logs);
  try {
    tracer.startSpan("manual").end();
    logger.emit({ eventName: "manual" });
    await Promise.all([pipeline.spanProcessor.forceFlush(), pipeline.logProcessor.forceFlush()]);
    if (entry.traces) expect(pipeline.spanExporter.getFinishedSpans()[0]?.name).toBe("manual");
    else expect(trace.getTracerProvider()).toBe(originalTrace);
    if (entry.logs)
      expect(pipeline.logExporter.getFinishedLogRecords()[0]?.eventName).toBe("manual");
    else expect(logs.getLoggerProvider()).toBe(originalLogs);
  } finally {
    await telemetry.shutdown();
  }
});
