// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { useMicrosoftOpenTelemetry } from "../../src/index.js";
import { getInstrumentations } from "../../src/instrumentation/browserInstrumentation/index.js";
import type { InstrumentationOptions, MicrosoftOpenTelemetryBrowser } from "../../src/types.js";
import { createInMemoryPipeline } from "../fixtures/telemetry.js";

/**
 * Exercises the constructed instrumentations against a real browser, registered the way an
 * application registers them: real `fetch`, real `XMLHttpRequest`, real patching of the global
 * objects. The unit tests assert what configuration is produced; these assert what that
 * configuration actually does once it is running.
 */

/** A path the dev server will answer, so a request completes rather than failing to connect. */
const APPLICATION_URL = new URL("/__application__", location.origin).toString();

let pipeline: ReturnType<typeof createInMemoryPipeline>;
let handle: MicrosoftOpenTelemetryBrowser | undefined;

async function start(options: InstrumentationOptions = {}): Promise<void> {
  pipeline = createInMemoryPipeline();
  handle = useMicrosoftOpenTelemetry({
    ...pipeline.options,
    instrumentations: await getInstrumentations(options),
  });
}

/** Resolves once the request has settled, whatever the outcome. */
async function request(url: string): Promise<void> {
  try {
    await fetch(url);
  } catch {
    // A non-2xx or blocked response is still a completed request as far as capture goes.
  }
}

function sendXhr(url: string): Promise<void> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.addEventListener("loadend", () => resolve());
    xhr.open("GET", url);
    xhr.send();
  });
}

/** Waits for the exporter to settle, then returns whatever was captured. */
async function captured(): Promise<ReadableSpan[]> {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await pipeline.spanProcessor.forceFlush();
  return pipeline.spanExporter.getFinishedSpans();
}

function urlsOf(spans: readonly ReadableSpan[]): string[] {
  return spans.map((span) => String(span.attributes["url.full"] ?? span.attributes["http.url"]));
}

afterEach(async () => {
  await handle?.shutdown();
  handle = undefined;
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
});

describe("configured instrumentations in a browser", () => {
  it("captures both a fetch and an XMLHttpRequest with no instrumentation options", async () => {
    await start();
    await request(APPLICATION_URL);
    await sendXhr(APPLICATION_URL);

    const spans = await captured();
    expect(spans).toHaveLength(2);
    expect(urlsOf(spans)).toEqual([APPLICATION_URL, APPLICATION_URL]);
  });

  it("captures nothing once the default instrumentations are turned off", async () => {
    await start({ fetch: { enabled: false }, xhr: { enabled: false } });

    await request(APPLICATION_URL);
    await sendXhr(APPLICATION_URL);

    expect(await captured()).toEqual([]);
  });

  it("does not patch fetch when fetch capture is turned off", async () => {
    const original = window.fetch;
    await start({ fetch: { enabled: false } });

    expect(window.fetch).toBe(original);
  });

  it("captures a fetch request once enabled", async () => {
    await start({ fetch: { enabled: true }, xhr: { enabled: false } });

    await request(APPLICATION_URL);

    const spans = await captured();
    expect(spans).toHaveLength(1);
    expect(urlsOf(spans)).toEqual([APPLICATION_URL]);
  });

  it("captures an XMLHttpRequest once enabled", async () => {
    await start({ xhr: { enabled: true }, fetch: { enabled: false } });

    await sendXhr(APPLICATION_URL);

    const spans = await captured();
    expect(spans).toHaveLength(1);
    expect(urlsOf(spans)).toEqual([APPLICATION_URL]);
  });

  describe("upstream settings reach the instrumentation", () => {
    it("applies a caller sanitizeUrl to the captured span", async () => {
      await start({
        fetch: { enabled: true, sanitizeUrl: () => "https://sanitized.example.test/" },
      });

      await request(`${APPLICATION_URL}?token=secret`);

      expect(urlsOf(await captured())).toEqual(["https://sanitized.example.test/"]);
    });

    it("invokes a caller requestHook and applyCustomAttributesOnSpan", async () => {
      const seen: string[] = [];
      await start({
        fetch: {
          enabled: true,
          requestHook: (span) => {
            seen.push("requestHook");
            span.setAttribute("test.request_hook", true);
          },
          applyCustomAttributesOnSpan: (span) => {
            seen.push("applyCustomAttributesOnSpan");
            span.setAttribute("test.custom_attributes", true);
          },
        },
      });

      await request(APPLICATION_URL);

      const spans = await captured();
      expect(seen).toEqual(["requestHook", "applyCustomAttributesOnSpan"]);
      expect(spans[0]?.attributes["test.request_hook"]).toBe(true);
      expect(spans[0]?.attributes["test.custom_attributes"]).toBe(true);
    });

    it("honours a caller ignoreUrls entry", async () => {
      await start({ fetch: { enabled: true, ignoreUrls: [APPLICATION_URL] } });

      await request(APPLICATION_URL);

      expect(await captured()).toEqual([]);
    });
  });
});
