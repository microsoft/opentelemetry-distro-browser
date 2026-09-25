// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { SpanKind, SpanStatusCode, type SpanContext } from "@opentelemetry/api";
import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setUnloading } from "../../../src/exporter/common.js";
import { AzureMonitorSpanExporter } from "../../../src/exporter/trace.js";

const connectionString =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test";
const spanContext: SpanContext = {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  traceFlags: 1,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeSpan(): ReadableSpan {
  return {
    name: "checkout",
    kind: SpanKind.CLIENT,
    spanContext: () => spanContext,
    startTime: [1_735_689_600, 0],
    duration: [0, 1_000_000],
    status: { code: SpanStatusCode.OK },
    attributes: {},
    links: [],
    events: [],
    resource: { attributes: {} },
    instrumentationScope: { name: "test" },
  } as unknown as ReadableSpan;
}

function exportSpan(exporter: AzureMonitorSpanExporter) {
  return new Promise<{ code: ExportResultCode; error?: Error }>((resolve) => {
    exporter.export([makeSpan()], resolve);
  });
}

describe("AzureMonitorSpanExporter", () => {
  it("maps spans, posts Breeze envelopes, and reports success", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const exporter = new AzureMonitorSpanExporter({ connectionString });

    await expect(exportSpan(exporter)).resolves.toEqual({ code: ExportResultCode.SUCCESS });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("https://example.test/v2/track");
    const request = fetch.mock.calls[0][1] as RequestInit;
    const response = new Response(request.body);
    const body =
      new Headers(request.headers).get("content-encoding") === "gzip"
        ? await new Response(response.body!.pipeThrough(new DecompressionStream("gzip"))).text()
        : await response.text();
    const envelopes = JSON.parse(body);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).toMatchObject({
      name: "Microsoft.ApplicationInsights.RemoteDependency",
      iKey: "00000000-0000-0000-0000-000000000000",
    });
  });

  it("converts HTTP and transport failures to failed ExportResults", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 503 })),
    );
    const failedResponse = new AzureMonitorSpanExporter({ connectionString });
    await expect(exportSpan(failedResponse)).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
      error: expect.any(Error),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>(async () => {
        throw new Error("offline");
      }),
    );
    const failedFetch = new AzureMonitorSpanExporter({ connectionString });
    await expect(exportSpan(failedFetch)).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
      error: expect.objectContaining({ message: "offline" }),
    });
  });

  it("waits for active exports and rejects exports after shutdown", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    vi.stubGlobal("fetch", fetch);
    const exporter = new AzureMonitorSpanExporter({ connectionString });
    const result = exportSpan(exporter);
    let flushed = false;
    const flush = exporter.forceFlush().then(() => (flushed = true));

    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"));
    expect(flushed).toBe(false);
    resolveFetch(new Response("", { status: 200 }));
    await flush;
    await expect(result).resolves.toEqual({ code: ExportResultCode.SUCCESS });

    await exporter.shutdown();
    await expect(exportSpan(exporter)).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
    });
  });

  it("uses beacon while unloading", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("page unloading");
    });
    vi.stubGlobal("fetch", fetch);
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    const exporter = new AzureMonitorSpanExporter({ connectionString });
    setUnloading(true);

    try {
      await expect(exportSpan(exporter)).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0][1]).toMatchObject({ keepalive: true });
      expect(sendBeacon).toHaveBeenCalledOnce();
    } finally {
      setUnloading(false);
    }
  });
});
