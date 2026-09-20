// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { expect, it, vi } from "vitest";
import standardBundle from "../../dist/browser/opentelemetry-distro-browser.js?raw";
import minifiedBundle from "../../dist/browser/opentelemetry-distro-browser.min.js?raw";
import { version } from "../../package.json";
import type { MicrosoftOpenTelemetryBrowser } from "../../src/index.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

declare global {
  interface Window {
    OpenTelemetryBrowser?: typeof import("../../src/index.js");
  }
}

it.each([
  { name: "standard", source: standardBundle },
  { name: "minified", source: minifiedBundle },
])("initializes the $name bundle as a browser script", async ({ source }) => {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  let telemetry: MicrosoftOpenTelemetryBrowser | undefined;

  try {
    const frameWindow = frame.contentWindow;
    if (!frameWindow) {
      throw new Error("Could not create the browser script test frame.");
    }

    const script = frameWindow.document.createElement("script");
    script.textContent = source;
    frameWindow.document.head.append(script);

    expect(frameWindow.OpenTelemetryBrowser?.OPENTELEMETRY_BROWSER_VERSION).toBe(version);
    const distro = frameWindow.OpenTelemetryBrowser;
    if (!distro) throw new Error("The browser bundle did not load.");
    const pipeline = createInMemoryPipeline();
    const spanFlush = vi.spyOn(pipeline.spanProcessor, "forceFlush");
    const logFlush = vi.spyOn(pipeline.logProcessor, "forceFlush");
    const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
    const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
    telemetry = distro.useMicrosoftOpenTelemetry(pipeline.options);
    await telemetry.forceFlush();
    expect(spanFlush).toHaveBeenCalledOnce();
    expect(logFlush).toHaveBeenCalledOnce();
    const shutdown = telemetry.shutdown();
    expect(telemetry.shutdown()).toBe(shutdown);
    await shutdown;
    expect(spanShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
  } finally {
    await telemetry?.shutdown();
    frame.remove();
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
