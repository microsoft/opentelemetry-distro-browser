// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { expect, it, vi } from "vitest";
import minifiedBundle from "../../dist/esm/index.min.js?raw";
import { version } from "../../package.json";
import type { MicrosoftOpenTelemetryBrowser } from "../../src/index.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

it("initializes the minified bundle as native browser ESM", async () => {
  const url = URL.createObjectURL(new Blob([minifiedBundle], { type: "text/javascript" }));
  let telemetry: MicrosoftOpenTelemetryBrowser | undefined;
  try {
    // Import the emitted bytes directly, without Vite transforming the module.
    const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url);
    expect(Object.keys(distro).sort()).toEqual([
      "OPENTELEMETRY_BROWSER_VERSION",
      "useMicrosoftOpenTelemetry",
    ]);
    expect(distro.OPENTELEMETRY_BROWSER_VERSION).toBe(version);
    expect(window).not.toHaveProperty("OpenTelemetryBrowser");
    const pipeline = createInMemoryPipeline();
    const processors = [pipeline.spanProcessor, pipeline.logProcessor];
    const flushes = processors.map((processor) => vi.spyOn(processor, "forceFlush"));
    const shutdowns = processors.map((processor) => vi.spyOn(processor, "shutdown"));
    telemetry = distro.useMicrosoftOpenTelemetry(pipeline.options);
    await telemetry.forceFlush();
    for (const flush of flushes) expect(flush).toHaveBeenCalledOnce();
    const shutdown = telemetry.shutdown();
    expect(telemetry.shutdown()).toBe(shutdown);
    await shutdown;
    for (const shutdown of shutdowns) expect(shutdown).toHaveBeenCalledOnce();
  } finally {
    await telemetry?.shutdown();
    URL.revokeObjectURL(url);
  }
});

it("exports manual telemetry through the built ESM entry point in a browser", async () => {
  // Type-check from a clean checkout; load the built artifact only at runtime.
  const entry = new URL("../../dist/esm/index.js", import.meta.url);
  const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ entry.href);
  const pipeline = createInMemoryPipeline();
  const tracer = trace.getTracer("browser-consumer");
  const logger = logs.getLogger("browser-consumer");
  const telemetry = distro.useMicrosoftOpenTelemetry(pipeline.options);
  try {
    tracer.startSpan("manual").end();
    logger.emit({ eventName: "manual" });
    await telemetry.forceFlush();
    expect(pipeline.spanExporter.getFinishedSpans()[0]?.name).toBe("manual");
    expect(pipeline.logExporter.getFinishedLogRecords()[0]?.eventName).toBe("manual");
  } finally {
    await telemetry.shutdown();
  }
});
