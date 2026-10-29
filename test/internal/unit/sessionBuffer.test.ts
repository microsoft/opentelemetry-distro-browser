// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag, SpanKind } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AzureMonitorExportClient, type AzureMonitorOptions } from "../../../src/exporter/base.js";
import { beginUnloading, endUnloading } from "../../../src/exporter/common.js";
import { MAX_BEACON_BODY_SIZE } from "../../../src/exporter/constants.js";
import {
  MAX_SESSION_BUFFER_AGE_MS,
  MAX_SESSION_BUFFER_LENGTH,
  SESSION_BUFFER_KEY_PREFIX,
  SessionBuffer,
  sessionBufferStorage,
} from "../../../src/exporter/sessionBuffer.js";
import { spanToEnvelope } from "../../../src/exporter/spanUtils.js";
import type { AzureMonitorEnvelope, MetricData } from "../../../src/exporter/telemetryModels.js";
import { TEST_INSTRUMENTATION_KEY } from "../../fixtures/azureMonitor.js";
import {
  MemoryStorage,
  setSessionStorage,
  testSessionStorage,
} from "../../fixtures/sessionStorageSetup.js";
import { createReadableSpan } from "../../fixtures/telemetry.js";

const OTHER_INSTRUMENTATION_KEY = "00000000-0000-4000-8000-000000000002";
const endpoint = "https://example.test";
const connectionString = (key = TEST_INSTRUMENTATION_KEY): string =>
  `InstrumentationKey=${key};IngestionEndpoint=${endpoint}`;

let page = 0;
const clients: AzureMonitorExportClient[] = [];
const hanging: Array<(response: Response) => void> = [];

/** A response that stays pending until settled, like a request cut off by navigation. */
const hang = (): Promise<Response> => new Promise((resolve) => hanging.push(resolve));

function settleHanging(status: number): void {
  for (const resolve of hanging.splice(0)) resolve(new Response("", { status }));
}

/** Simulates a new document in the same tab, which has its own `performance.timeOrigin`. */
function loadPage(): void {
  page++;
  Object.defineProperty(performance, "timeOrigin", {
    configurable: true,
    value: 1_700_000_000_000 + page,
  });
}

/** Simulates `pagehide`, which releases buffered telemetry to the next document. */
function hidePage(): void {
  window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
}

/** Simulates a back/forward cache restore of the hidden document. */
function restorePage(): void {
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
}

function breezeResponse(
  errors: Array<{ index: number; statusCode: number }>,
  headers = {},
  itemsReceived = 3,
) {
  return new Response(
    JSON.stringify({
      itemsReceived,
      itemsAccepted: itemsReceived - errors.length,
      errors: errors.map((error) => ({ ...error, message: "error" })),
    }),
    { status: 206, headers },
  );
}

function createClient(options: Partial<AzureMonitorOptions> = {}): AzureMonitorExportClient {
  const client = new AzureMonitorExportClient({ connectionString: connectionString(), ...options });
  clients.push(client);
  return client;
}

function envelope(name = "span"): AzureMonitorEnvelope {
  return spanToEnvelope(createReadableSpan({ name }), TEST_INSTRUMENTATION_KEY);
}

function exportAsync(
  client: AzureMonitorExportClient,
  envelopes: readonly AzureMonitorEnvelope[],
): Promise<ExportResult> {
  return new Promise((resolve) => client.export(envelopes, resolve));
}

function stubFetch(
  respond: () => Promise<Response> | Response = () => new Response("", { status: 200 }),
) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => respond());
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** Names of the envelopes in each request body, in send order. */
function sentNames(fetch: ReturnType<typeof stubFetch>): string[][] {
  return fetch.mock.calls.map(([, init]) =>
    (JSON.parse(new TextDecoder().decode(init?.body as Uint8Array)) as AzureMonitorEnvelope[]).map(
      (item) => (item.data.baseData as { name?: string }).name ?? "",
    ),
  );
}

function bufferKeys(): string[] {
  return Array.from({ length: testSessionStorage.length }, (_, index) =>
    testSessionStorage.key(index),
  ).filter((key): key is string => key?.startsWith(SESSION_BUFFER_KEY_PREFIX) === true);
}

async function reportedCounts(
  fetch: ReturnType<typeof stubFetch>,
): Promise<Record<string, number>> {
  const [url, init] = fetch.mock.calls.at(-1)!;
  const metrics: AzureMonitorEnvelope<MetricData>[] = await new Request(url, init).json();
  const entries = metrics.map(
    ({ data: { baseData } }) =>
      [
        [
          baseData.metrics[0].name,
          baseData.properties?.telemetryType,
          baseData.properties?.dropCode,
        ]
          .filter(Boolean)
          .join(":"),
        baseData.metrics[0].value,
      ] as const,
  );
  expect(new Set(entries.map(([key]) => key)).size).toBe(entries.length);
  return Object.fromEntries(entries);
}

function blockStorage(...methods: ("setItem" | "removeItem")[]): () => void {
  const mocks = methods.map((method) =>
    vi.spyOn(testSessionStorage, method).mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    }),
  );
  return () => {
    for (const mock of mocks) mock.mockRestore();
  };
}

beforeEach(() => {
  loadPage();
});

afterEach(async () => {
  settleHanging(200);
  await Promise.allSettled(clients.splice(0).map((client) => client.shutdown()));
  delete (performance as { timeOrigin?: number }).timeOrigin;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Azure Monitor sessionStorage buffer", () => {
  it("sends telemetry left unsent by the previous page first, exactly once", async () => {
    stubFetch(hang);
    void exportAsync(createClient(), [envelope("left behind")]);
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));
    hidePage();

    loadPage();
    const fetch = stubFetch();
    const secondPage = createClient();
    await exportAsync(secondPage, [envelope("new")]);
    await secondPage.forceFlush();

    expect(sentNames(fetch)).toEqual([["left behind"], ["new"]]);
    expect(bufferKeys()).toEqual([]);

    loadPage();
    const thirdFetch = stubFetch();
    await createClient().forceFlush();
    expect(thirdFetch).not.toHaveBeenCalled();
  });

  it("removes telemetry once ingestion accepts or permanently rejects it", async () => {
    let status = 200;
    stubFetch(() => new Response("", { status }));
    const client = createClient();

    await expect(exportAsync(client, [envelope("accepted")])).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    status = 400;
    await expect(exportAsync(client, [envelope("rejected")])).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
    });
    hidePage();
    expect(bufferKeys()).toEqual([]);

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps telemetry that failed with a retriable error for the next page", async () => {
    // Retry-After beyond the retry-wait budget fails the export without waiting.
    stubFetch(() => new Response("", { status: 503, headers: { "retry-after": "86400" } }));
    const client = createClient({ sdkStats: { enabled: true } });
    const count = vi.spyOn(client.itemStats!, "countEnvelopes");
    await expect(exportAsync(client, [envelope("throttled")])).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
    });
    expect(count).not.toHaveBeenCalled();
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["throttled"]]);
  });

  it("retains a failed dispatched unload before deciding whether to count a drop", async () => {
    const firstFetch = stubFetch(() => Promise.reject(new TypeError("offline")));
    const client = createClient({ sdkStats: { enabled: true }, disableBeacon: true });
    const count = vi.spyOn(client.itemStats!, "countEnvelopes");
    beginUnloading();
    try {
      await expect(exportAsync(client, [envelope("deferred")])).resolves.toMatchObject({
        code: ExportResultCode.FAILED,
      });
    } finally {
      endUnloading();
    }
    expect(firstFetch).toHaveBeenCalledOnce();
    expect(count).not.toHaveBeenCalled();
    hidePage();
    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["deferred"]]);
  });

  it("does not resend unload requests the browser accepted", async () => {
    const fetch = stubFetch(hang);
    const client = createClient();
    beginUnloading();
    try {
      client.export([envelope("unload")], () => {});
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    } finally {
      endUnloading();
    }
    expect(bufferKeys()).toEqual([]);

    loadPage();
    const nextFetch = stubFetch();
    await createClient().forceFlush();
    expect(nextFetch).not.toHaveBeenCalled();
  });

  it("buffers envelopes that do not fit the unload beacon for the next page", async () => {
    stubFetch(hang);
    const client = createClient();
    const large = (name: string): AzureMonitorEnvelope => ({
      ...envelope(name),
      tags: { large: "x".repeat(MAX_BEACON_BODY_SIZE * 0.6) },
    });
    let result: ExportResult | undefined;
    hidePage();
    beginUnloading();
    try {
      client.export([large("sent"), large("dropped")], (value) => (result = value));
    } finally {
      endUnloading();
    }
    settleHanging(200);
    await vi.waitFor(() => expect(result).toBeDefined());
    expect(result?.error?.message).toBe("Unload beacon limit exceeded; sent 1 of 2 envelopes.");

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["dropped"]]);
  });

  it("buffers an unload payload that cannot fit any beacon", async () => {
    const fetch = stubFetch();
    const client = createClient();
    const oversized = {
      ...envelope("oversized"),
      tags: { large: "x".repeat(MAX_BEACON_BODY_SIZE) },
    };
    let result: ExportResult | undefined;
    hidePage();
    beginUnloading();
    try {
      client.export([oversized], (value) => (result = value));
    } finally {
      endUnloading();
    }
    expect(result?.error).toBeInstanceOf(RangeError);
    expect(fetch).not.toHaveBeenCalled();

    loadPage();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["oversized"]]);
  });

  it.each([false, true])(
    "does not rewrite an oversized unload batch just to attach stats (%s)",
    async (enabled) => {
      const client = createClient({ sdkStats: { enabled } });
      const original = testSessionStorage.setItem.bind(testSessionStorage);
      const write = vi
        .spyOn(testSessionStorage, "setItem")
        .mockImplementationOnce(original)
        .mockImplementationOnce(() => {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        });
      const oversized = { ...envelope("kept"), tags: { large: "x".repeat(MAX_BEACON_BODY_SIZE) } };
      beginUnloading();
      try {
        await expect(exportAsync(client, [oversized])).resolves.toMatchObject({
          code: ExportResultCode.FAILED,
        });
      } finally {
        endUnloading();
      }
      expect(write).toHaveBeenCalledOnce();
      expect(testSessionStorage.getItem(bufferKeys()[0])).toContain("kept");
      write.mockRestore();
      hidePage();
      loadPage();
      const fetch = stubFetch();
      await createClient().forceFlush();
      expect(sentNames(fetch)).toEqual([["kept"]]);
    },
  );

  it.each(
    (["whole", "partial"] as const).flatMap((mode) =>
      [false, true].map((networkFailure) => ({ mode, networkFailure })),
    ),
  )(
    "persists $mode retry codes before cross-page expiry (network failure: $networkFailure)",
    async ({ mode, networkFailure }) => {
      const firstFetch = stubFetch(() =>
        mode === "whole"
          ? new Response(null, { status: 503, headers: { "retry-after": "1" } })
          : breezeResponse(
              [
                { index: 1, statusCode: 429 },
                { index: 0, statusCode: 503 },
              ],
              { "retry-after": "1" },
              2,
            ),
      );
      const client = createClient({ sdkStats: { enabled: true } });
      const items = [envelope("retry-503")];
      if (mode === "partial")
        items.push(
          spanToEnvelope(createReadableSpan({ kind: SpanKind.SERVER }), TEST_INSTRUMENTATION_KEY),
        );
      const pending = exportAsync(client, items);
      await vi.waitFor(() => {
        const record: unknown[] = JSON.parse(testSessionStorage.getItem(bufferKeys()[0]) ?? "[]");
        expect((record[1] as unknown[])?.[2]).toEqual(mode === "whole" ? "503" : ["429", "503"]);
      });
      expect(firstFetch).toHaveBeenCalledOnce();
      if (networkFailure) {
        firstFetch.mockRejectedValueOnce(new TypeError("Network unavailable"));
        await vi.waitFor(
          () => {
            const record: unknown[] = JSON.parse(
              testSessionStorage.getItem(bufferKeys()[0]) ?? "[]",
            );
            expect((record[1] as unknown[])?.[2]).toBe("CLIENT_EXCEPTION");
          },
          { timeout: 3000 },
        );
        expect(firstFetch).toHaveBeenCalledTimes(2);
      }
      hidePage();
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + MAX_SESSION_BUFFER_AGE_MS + 1);
      loadPage();
      const fetch = stubFetch();
      await createClient({ sdkStats: { enabled: true } }).forceFlush();
      expect(await reportedCounts(fetch)).toEqual({
        [`Item_Dropped_Count:DEPENDENCY:${networkFailure ? "CLIENT_EXCEPTION" : "503"}`]: 1,
        ...(mode === "partial"
          ? { [`Item_Dropped_Count:REQUEST:${networkFailure ? "CLIENT_EXCEPTION" : "429"}`]: 1 }
          : {}),
      });
      await pending;
      expect(firstFetch).toHaveBeenCalledTimes(networkFailure ? 2 : 1);
    },
  );

  it.each([false, true])(
    "commits unreleased outcomes on shutdown even if storage remains blocked (accepted: %s)",
    async (accepted) => {
      vi.spyOn(diag, "warn").mockImplementation(() => {});
      const firstFetch = stubFetch(hang);
      const client = createClient({ sdkStats: { enabled: true } });
      const count = vi.spyOn(client.itemStats!, "countEnvelopes");
      const pending = exportAsync(client, [envelope("unreleased")]);
      await vi.waitFor(() => expect(hanging).toHaveLength(1));
      const restoreStorage = blockStorage("setItem", "removeItem");
      hanging.shift()!(
        new Response(null, {
          status: accepted ? 200 : 503,
          headers: { "retry-after": "86400" },
        }),
      );
      await pending;
      expect(count).not.toHaveBeenCalled();
      firstFetch.mockResolvedValue(new Response(null));
      await client.shutdown();
      expect(count).toHaveBeenCalledOnce();
      expect(count.mock.calls[0][0]).toBe(accepted ? "Success" : "Dropped");
      restoreStorage();
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + MAX_SESSION_BUFFER_AGE_MS + 1);
      loadPage();
      const fetch = stubFetch();
      await createClient({ sdkStats: { enabled: true } }).forceFlush();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("preserves near-limit payloads when optional drop metadata cannot fit", () => {
    const now = Date.now();
    const emptyBody = JSON.stringify([{ name: "fits", pad: "" }]);
    const padding = MAX_SESSION_BUFFER_LENGTH - `[${now},${emptyBody}]`.length;
    const body = JSON.stringify([{ name: "fits", pad: "x".repeat(padding) }]);
    const buffer = new SessionBuffer("near-limit");
    const onDrop = vi.fn();
    const id = buffer.add(body, now, "503");
    expect(buffer.retain(id, onDrop, "503")).toBe(true);
    expect(onDrop).not.toHaveBeenCalled();
    const record: [number, [number, unknown[], unknown?]] = JSON.parse(
      testSessionStorage.getItem(bufferKeys()[0])!,
    );
    expect(JSON.stringify(record[1][1])).toBe(body);
    expect(record[1][2]).toBeUndefined();
    buffer.dispose();
    expect(onDrop).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "keeps a batch after a metadata-only write failure (release after recovery: %s)",
    (release) => {
      vi.spyOn(diag, "warn").mockImplementation(() => {});
      const buffer = new SessionBuffer("metadata-only");
      const body = '[{"name":"kept"}]';
      const id = buffer.add(body);
      buffer.begin(id);
      const before = testSessionStorage.getItem(bufferKeys()[0]);
      const restoreStorage = blockStorage("setItem");
      buffer.settle(id, body, true, "503");
      const onDrop = vi.fn();
      expect(buffer.retain(id, onDrop, "503")).toBe(true);
      expect(testSessionStorage.getItem(bufferKeys()[0])).toBe(before);
      expect(onDrop).not.toHaveBeenCalled();
      restoreStorage();
      if (release) {
        hidePage();
        expect(testSessionStorage.getItem(bufferKeys()[0])).toMatch(/^\[1,/);
        loadPage();
        const next = new SessionBuffer("metadata-only");
        expect(next.adopt().map(([, retained]) => retained)).toEqual([body]);
        expect(next.adopt()).toEqual([]);
        next.dispose();
      }
      buffer.dispose();
      expect(onDrop).toHaveBeenCalledTimes(release ? 0 : 1);
    },
  );

  it("retries the smaller payload when native quota rejects only the optional metadata", async () => {
    const originalWrite = testSessionStorage.setItem.bind(testSessionStorage);
    vi.spyOn(testSessionStorage, "setItem").mockImplementation((key, value) => {
      const record: unknown[] = JSON.parse(value);
      if (Array.isArray(record[1]) && record[1].length > 2)
        throw new DOMException("Metadata exceeds quota", "QuotaExceededError");
      originalWrite(key, value);
    });
    const client = createClient({ sdkStats: { enabled: true } });
    const item = { ...envelope("retained"), tags: { large: "x".repeat(MAX_BEACON_BODY_SIZE) } };
    beginUnloading();
    try {
      await exportAsync(client, [item]);
    } finally {
      endUnloading();
    }
    hidePage();
    expect(testSessionStorage.getItem(bufferKeys()[0])).toContain("retained");
    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["retained"]]);
  });
  it("does not adopt telemetry from live documents or the same document", async () => {
    stubFetch(hang);
    void exportAsync(createClient(), [envelope("live")]);
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));

    const fetch = stubFetch();
    await createClient().forceFlush();
    loadPage();
    await createClient().forceFlush();
    expect(fetch).not.toHaveBeenCalled();
    expect(bufferKeys()).toHaveLength(1);
  });

  it("does not release a hidden but live page's telemetry", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    stubFetch(hang);
    const client = createClient();
    void exportAsync(client, [envelope("live")]);
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));
    // Visibility flushes run as unloads, but the document stays alive.
    beginUnloading();
    endUnloading();
    expect(testSessionStorage.getItem(bufferKeys()[0])).toMatch(/^\[0,/);

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops telemetry another document adopted when restored from the back/forward cache", async () => {
    stubFetch(hang);
    const original = exportAsync(createClient(), [envelope("handed off")]);
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["handed off"]]);

    restorePage();
    // The original request now fails retriably, but the adopting document already delivered it.
    for (const resolve of hanging.splice(0)) {
      resolve(new Response("", { status: 503, headers: { "retry-after": "86400" } }));
    }
    await expect(original).resolves.toMatchObject({ code: ExportResultCode.FAILED });
    expect(bufferKeys()).toEqual([]);
  });

  it("stops retrying telemetry another document adopted", async () => {
    const firstFetch = stubFetch(
      () => new Response("", { status: 503, headers: { "retry-after": "1" } }),
    );
    const client = createClient({ sdkStats: { enabled: true } });
    const count = vi.spyOn(client.itemStats!, "countEnvelopes");
    const original = exportAsync(client, [envelope("handed off")]);
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledOnce());
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["handed off"]]);

    restorePage();
    await expect(original).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
      error: { message: "Telemetry was handed off to another page." },
    });
    expect(firstFetch).toHaveBeenCalledOnce();
    expect(count.mock.calls.filter(([outcome]) => outcome !== "Success")).toEqual([]);
    expect(bufferKeys()).toEqual([]);
  });

  it("keeps only new telemetry exported on restore before the buffer reconciles", async () => {
    let client: AzureMonitorExportClient | undefined;
    // Registered before the buffer's own listener, so it runs first.
    const onShow = (): void => client?.export([envelope("restored")], () => {});
    window.addEventListener("pageshow", onShow);
    try {
      stubFetch(hang);
      client = createClient();
      void exportAsync(client, [envelope("handed off")]);
      await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));
      hidePage();

      loadPage();
      const fetch = stubFetch();
      await createClient().forceFlush();
      expect(sentNames(fetch)).toEqual([["handed off"]]);

      restorePage();
    } finally {
      window.removeEventListener("pageshow", onShow);
    }
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["restored"]]);
  });

  it("buffers retriable envelopes from a partial unload response", async () => {
    stubFetch(() =>
      breezeResponse([
        { index: 1, statusCode: 503 },
        { index: 2, statusCode: 400 },
      ]),
    );
    const client = createClient();
    let result: Promise<ExportResult>;
    beginUnloading();
    try {
      result = exportAsync(client, [envelope("accepted"), envelope("retriable"), envelope("bad")]);
    } finally {
      endUnloading();
    }
    await expect(result).resolves.toMatchObject({ code: ExportResultCode.FAILED });
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["retriable"]]);
  });

  it("keeps a dispatched batch while its partial response body is read", async () => {
    let body!: ReadableStreamDefaultController;
    const firstFetch = stubFetch(
      () =>
        new Response(new ReadableStream({ start: (controller) => void (body = controller) }), {
          status: 206,
        }),
    );
    const client = createClient();
    beginUnloading();
    try {
      void exportAsync(client, [envelope("first"), envelope("second")]);
    } finally {
      endUnloading();
    }
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledOnce());
    // The dispatched batch left the record; the 206 headers bring it back.
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["first", "second"]]);
    body.close();
  });

  it.each(
    [false, true].flatMap((unloading) =>
      ["not json", JSON.stringify({ itemsReceived: 1, itemsAccepted: 1, errors: [] })].map(
        (body) => ({ unloading, body }),
      ),
    ),
  )(
    "fails and retains an invalid partial response $body (unloading: $unloading)",
    async ({ unloading, body }) => {
      stubFetch(() => new Response(body, { status: 206 }));
      const client = createClient({ sdkStats: { enabled: true } });
      const count = vi.spyOn(client.itemStats!, "countEnvelopes");
      let result: Promise<ExportResult>;
      if (unloading) beginUnloading();
      try {
        result = exportAsync(client, [envelope("first"), envelope("second")]);
      } finally {
        if (unloading) endUnloading();
      }
      await expect(result).resolves.toMatchObject({
        code: ExportResultCode.FAILED,
        error: { message: "Azure Monitor export failed with HTTP 206." },
      });
      expect(count).not.toHaveBeenCalled();
      hidePage();

      loadPage();
      const fetch = stubFetch();
      await createClient().forceFlush();
      expect(sentNames(fetch)).toEqual([["first", "second"]]);
    },
  );

  it.each([200, 400])(
    "does not resend telemetry after HTTP %i when its body cannot be read",
    async (status) => {
      const firstFetch = stubFetch(
        () =>
          new Response(
            new ReadableStream({ start: (controller) => controller.error(new TypeError("reset")) }),
            { status },
          ),
      );
      const client = createClient({ sdkStats: { enabled: true } });
      await expect(exportAsync(client, [envelope("settled")])).resolves.toMatchObject({
        code: ExportResultCode.FAILED,
      });
      firstFetch.mockResolvedValue(new Response(null));
      await client.forceFlush();
      expect(firstFetch).toHaveBeenCalledTimes(2);
      expect(await reportedCounts(firstFetch)).toEqual({
        [status === 200 ? "Item_Success_Count:DEPENDENCY" : "Item_Dropped_Count:DEPENDENCY:400"]: 1,
      });
      hidePage();
      expect(bufferKeys()).toEqual([]);

      loadPage();
      const fetch = stubFetch();
      await createClient().forceFlush();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not fall back to a beacon for telemetry another document adopted", async () => {
    const sendBeacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    let failBody: (() => void) | undefined;
    const firstFetch = stubFetch(
      () =>
        new Response(
          new ReadableStream({
            start: (controller) => (failBody = () => controller.error(new TypeError("reset"))),
          }),
          { status: 503 },
        ),
    );
    const client = createClient();
    let original: Promise<ExportResult>;
    // A hidden-visibility flush whose response body is still being read when the page freezes.
    beginUnloading();
    try {
      original = exportAsync(client, [envelope("handed off")]);
    } finally {
      endUnloading();
    }
    await vi.waitFor(() => expect(failBody).toBeDefined());
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(1));
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["handed off"]]);

    restorePage();
    failBody?.();
    await expect(original).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
      error: { message: "Telemetry was handed off to another page." },
    });
    expect(firstFetch).toHaveBeenCalledOnce();
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("keeps dispatched telemetry owned when its record was handed off", async () => {
    const firstFetch = stubFetch(hang);
    const client = createClient();
    void exportAsync(client, [envelope("buffered")]);
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledOnce());
    let dispatched: Promise<ExportResult>;
    beginUnloading();
    try {
      dispatched = exportAsync(client, [envelope("dispatched")]);
    } finally {
      endUnloading();
    }
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledTimes(2));
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["buffered"]]);

    restorePage();
    const [buffered, unload] = hanging.splice(0);
    buffered(new Response("", { status: 503, headers: { "retry-after": "86400" } }));
    unload(new Response("", { status: 503 }));
    await expect(dispatched).resolves.toMatchObject({ code: ExportResultCode.FAILED });
    hidePage();

    loadPage();
    const nextFetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(nextFetch)).toEqual([["dispatched"]]);
  });

  it("reclaims its telemetry when restored before another document adopts it", () => {
    const buffer = new SessionBuffer("destination");
    buffer.add('[{"name":"kept"}]');
    hidePage();
    expect(testSessionStorage.getItem(bufferKeys()[0])).toMatch(/^\[1,/);

    restorePage();
    expect(testSessionStorage.getItem(bufferKeys()[0])).toMatch(/^\[0,/);
    buffer.dispose();
  });

  it("buffers only outstanding retriable envelopes after a partial response", async () => {
    // Retry-After beyond the retry-wait budget fails the retry without waiting.
    stubFetch(() =>
      breezeResponse(
        [
          { index: 1, statusCode: 503 },
          { index: 2, statusCode: 400 },
        ],
        { "retry-after": "86400" },
      ),
    );
    await expect(
      exportAsync(createClient(), [envelope("accepted"), envelope("retriable"), envelope("bad")]),
    ).resolves.toMatchObject({ code: ExportResultCode.FAILED });
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["retriable"]]);
  });

  it("removes a partially accepted batch once its retry succeeds", async () => {
    const fetch = stubFetch();
    fetch.mockResolvedValueOnce(
      breezeResponse([{ index: 1, statusCode: 503 }], { "retry-after": "0" }, 2),
    );
    await expect(
      exportAsync(createClient(), [envelope("accepted"), envelope("retried")]),
    ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
    expect(sentNames(fetch)).toEqual([["accepted", "retried"], ["retried"]]);
    expect(bufferKeys()).toEqual([]);
  });

  it("does not access sessionStorage when storage is disabled", async () => {
    const options = { connectionString: connectionString() };
    sessionBufferStorage.set(options, null);
    const getter = vi.fn(() => testSessionStorage);
    Object.defineProperty(window, "sessionStorage", { configurable: true, get: getter });
    stubFetch(() => new Response("", { status: 503, headers: { "retry-after": "86400" } }));
    const client = new AzureMonitorExportClient(options);
    clients.push(client);
    await exportAsync(client, [envelope()]);
    hidePage();
    await client.shutdown();
    expect(getter).not.toHaveBeenCalled();
  });

  it("keeps telemetry for different connection strings apart and adopts it once", async () => {
    const other = { connectionString: connectionString(OTHER_INSTRUMENTATION_KEY) };
    stubFetch(hang);
    void exportAsync(createClient(), [envelope("first")]);
    void exportAsync(createClient(other), [envelope("second")]);
    await vi.waitFor(() => expect(bufferKeys()).toHaveLength(2));
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["first"]]);

    await createClient(other).forceFlush();
    expect(sentNames(fetch)).toEqual([["first"], ["second"]]);
  });

  it("exports without throwing when sessionStorage is unavailable", async () => {
    setSessionStorage(undefined);
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
    const fetch = stubFetch();
    const client = createClient();

    await expect(exportAsync(client, [envelope()])).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    await expect(exportAsync(client, [envelope()])).resolves.toEqual({
      code: ExportResultCode.SUCCESS,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.filter(([message]) => message.includes("sessionStorage"))).toHaveLength(
      1,
    );
  });

  it("removes its record without throwing when sessionStorage is full", () => {
    const storage = new MemoryStorage();
    setSessionStorage(storage);
    vi.spyOn(diag, "warn").mockImplementation(() => {});
    const buffer = new SessionBuffer("destination");
    const first = buffer.add('[{"name":"first"}]');
    expect(storage.length).toBe(1);
    expect(buffer.retain(first, vi.fn())).toBe(true);

    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    const setItem = vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    expect(() => buffer.add('[{"name":"second"}]')).not.toThrow();
    expect(storage.length).toBe(0);
    expect(buffer.retain(first, vi.fn())).toBe(false);
    expect(() => buffer.settle(first, "", false)).not.toThrow();
    // Later batches back off instead of retrying the failing write each time.
    buffer.add('[{"name":"third"}]');
    buffer.add('[{"name":"fourth"}]');
    buffer.add('[{"name":"fifth"}]');
    expect(setItem).toHaveBeenCalledTimes(2);
    buffer.dispose();
  });

  it("bounds buffered telemetry by length, evicting the oldest first", () => {
    const buffer = new SessionBuffer("destination");
    const body = (name: string): string =>
      `[{"name":"${name}","pad":"${"x".repeat(MAX_SESSION_BUFFER_LENGTH / 3)}"}]`;
    const oldest = buffer.add(body("oldest"));
    buffer.add(body("middle"));
    const newest = buffer.add(body("newest"));

    expect(buffer.retain(oldest, vi.fn())).toBe(false);
    expect(buffer.retain(newest, vi.fn())).toBe(true);
    const stored = testSessionStorage.getItem(bufferKeys()[0]) ?? "";
    expect(stored.length).toBeLessThanOrEqual(MAX_SESSION_BUFFER_LENGTH + 4);
    expect(stored).not.toContain("oldest");
    expect(stored).toContain("middle");
    expect(stored).toContain("newest");
    buffer.dispose();
  });

  it("evicts the oldest batches by timestamp, not insertion order", () => {
    const buffer = new SessionBuffer("destination");
    const now = Date.now();
    const body = (name: string, length: number): string =>
      `[{"name":"${name}","pad":"${"x".repeat(length)}"}]`;
    // Adopted records can interleave timestamps and have unequal sizes.
    buffer.add(body("newest", (MAX_SESSION_BUFFER_LENGTH * 3) / 5), now);
    buffer.add(body("oldest", MAX_SESSION_BUFFER_LENGTH / 5), now - 2000);
    buffer.add(body("middle", MAX_SESSION_BUFFER_LENGTH * 0.3), now - 1000);

    const stored = testSessionStorage.getItem(bufferKeys()[0]) ?? "";
    expect(stored).not.toContain("oldest");
    expect(stored.indexOf("middle")).toBeGreaterThan(-1);
    expect(stored.indexOf("middle")).toBeLessThan(stored.indexOf("newest"));
    buffer.dispose();
  });

  it("evicts every batch older than one that overflows the buffer", () => {
    const buffer = new SessionBuffer("destination");
    const now = Date.now();
    const body = (name: string, length: number): string =>
      `[{"name":"${name}","pad":"${"x".repeat(length)}"}]`;
    buffer.add(body("oldest", 50 * 1024), now - 7000);
    buffer.add(body("middle", 90 * 1024), now - 6000);
    for (let index = 0; index < 5; index++) {
      buffer.add(body(`newer${index}`, 90 * 1024), now - 5000 + index);
    }

    const stored = testSessionStorage.getItem(bufferKeys()[0]) ?? "";
    expect(stored).not.toContain("oldest");
    expect(stored).not.toContain("middle");
    expect(stored).toContain("newer0");
    expect(stored).toContain("newer4");
    buffer.dispose();
  });

  it("drops a batch that cannot fit alone without evicting older ones", () => {
    const buffer = new SessionBuffer("destination");
    buffer.add('[{"name":"older"}]');
    buffer.add(`[{"name":"huge","pad":"${"x".repeat(MAX_SESSION_BUFFER_LENGTH)}"}]`);

    const stored = testSessionStorage.getItem(bufferKeys()[0]) ?? "";
    expect(stored).toContain("older");
    expect(stored).not.toContain("huge");
    buffer.dispose();
  });

  it("keeps endpoints whose keys could overlap apart", () => {
    const destination = `${TEST_INSTRUMENTATION_KEY}|https://example.test/ingest`;
    const other = new SessionBuffer(`${destination}|tenant-b`);
    other.add('[{"name":"tenant-b"}]');
    hidePage();

    loadPage();
    const buffer = new SessionBuffer(destination);
    expect(buffer.adopt()).toEqual([]);
    const tenantB = new SessionBuffer(`${destination}|tenant-b`);
    expect(tenantB.adopt().map(([, body]) => body)).toEqual(['[{"name":"tenant-b"}]']);
    for (const item of [other, buffer, tenantB]) item.dispose();
  });

  it("keeps evicted batches out when their requests later fail", () => {
    const buffer = new SessionBuffer("destination");
    const body = (name: string): string =>
      `[{"name":"${name}","pad":"${"x".repeat(MAX_SESSION_BUFFER_LENGTH / 3)}"}]`;
    const oldest = buffer.add(body("oldest"));
    buffer.begin(oldest);
    buffer.add(body("middle"));
    buffer.add(body("newest"));

    buffer.settle(oldest, body("oldest"), true);
    const stored = testSessionStorage.getItem(bufferKeys()[0]) ?? "";
    expect(stored).not.toContain("oldest");
    expect(stored).toContain("newest");
    buffer.dispose();
  });

  it("discards expired and malformed records", () => {
    const destination = `${TEST_INSTRUMENTATION_KEY}|${endpoint}`;
    const prefix = `${SESSION_BUFFER_KEY_PREFIX}${encodeURIComponent(destination)}|old-page|`;
    const now = Date.now();
    const expired = now - MAX_SESSION_BUFFER_AGE_MS - 1;
    testSessionStorage.setItem(
      `${prefix}a`,
      JSON.stringify([1, [expired, [{ name: "expired" }]], [now, [{ name: "fresh" }]]]),
    );
    testSessionStorage.setItem(`${prefix}b`, "{");
    testSessionStorage.setItem(`${prefix}c`, JSON.stringify([0, [expired, [{ name: "stale" }]]]));

    const buffer = new SessionBuffer(destination);
    expect(buffer.adopt().map(([, body]) => body)).toEqual(['[{"name":"fresh"}]']);
    expect(bufferKeys()).toHaveLength(1);
    buffer.dispose();
    expect(bufferKeys()).toEqual([]);
  });

  it("removes its record on shutdown", async () => {
    stubFetch(() => new Response("", { status: 503, headers: { "retry-after": "86400" } }));
    const client = createClient();
    await exportAsync(client, [envelope()]);
    expect(bufferKeys()).toHaveLength(1);

    await client.shutdown();
    expect(bufferKeys()).toEqual([]);
  });

  it.each(["payload", "partial", "retry"] as const)(
    "never restores a terminal %s drop after a transient storage failure",
    async (mode) => {
      vi.spyOn(diag, "warn").mockImplementation(() => {});
      const write = vi.spyOn(testSessionStorage, "setItem").mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });
      stubFetch(() =>
        mode === "partial"
          ? breezeResponse([{ index: 0, statusCode: 503 }], {}, 1)
          : new Response(null, { status: 503, headers: { "retry-after": "86400" } }),
      );
      const client = createClient({ sdkStats: { enabled: true } });
      const count = vi.spyOn(client.itemStats!, "countEnvelopes");
      const item =
        mode === "payload"
          ? { ...envelope("terminal"), tags: { large: "x".repeat(MAX_BEACON_BODY_SIZE) } }
          : envelope("terminal");
      if (mode !== "retry") beginUnloading();
      try {
        await expect(exportAsync(client, [item])).resolves.toMatchObject({
          code: ExportResultCode.FAILED,
        });
      } finally {
        if (mode !== "retry") endUnloading();
      }
      expect(count.mock.calls.filter(([outcome]) => outcome === "Dropped")).toHaveLength(1);
      write.mockRestore();
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
      hidePage();
      expect(bufferKeys()).toEqual([]);
      loadPage();
      const fetch = stubFetch();
      await createClient().forceFlush();
      expect(fetch).not.toHaveBeenCalled();
      expect(count.mock.calls.filter(([outcome]) => outcome === "Dropped")).toHaveLength(1);
    },
  );

  it("counts a handed-off retained batch only on its adopting page", async () => {
    const firstFetch = stubFetch(
      () => new Response(null, { status: 503, headers: { "retry-after": "86400" } }),
    );
    const client = createClient({ sdkStats: { enabled: true } });
    const count = vi.spyOn(client.itemStats!, "countEnvelopes");
    await exportAsync(client, [envelope("handed off")]);
    hidePage();
    loadPage();
    stubFetch();
    await createClient().forceFlush();
    firstFetch.mockResolvedValue(new Response(null));
    await client.shutdown();
    expect(count.mock.calls.filter(([outcome]) => outcome === "Dropped")).toEqual([]);
  });

  it.each(
    [false, true].flatMap((partial) =>
      ["adopt", "recover", "tombstone"].map((resolution) => ({ partial, resolution })),
    ),
  )(
    "settles stale accounting exactly once after $resolution (partial: $partial)",
    ({ partial, resolution }) => {
      vi.spyOn(diag, "warn").mockImplementation(() => {});
      const buffer = new SessionBuffer("outcomes");
      const original = '[{"name":"settled"},{"name":"retry"}]';
      const remaining = partial ? '[{"name":"retry"}]' : "[]";
      const id = buffer.add(original);
      buffer.begin(id);
      hidePage();
      const key = bufferKeys()[0];
      const before = testSessionStorage.getItem(key);
      const restoreStorage = blockStorage("setItem", "removeItem");
      const count = vi.fn();
      buffer.settle(id, remaining, partial);
      buffer.account(id, count);
      expect(count).not.toHaveBeenCalled();
      expect(testSessionStorage.getItem(key)).toBe(before);
      restoreStorage();
      if (resolution === "adopt") {
        loadPage();
        const next = new SessionBuffer("outcomes");
        expect(next.adopt().map(([, body]) => body)).toEqual([original]);
        next.dispose();
      } else {
        const restoreRemoval = resolution === "tombstone" ? blockStorage("removeItem") : () => {};
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000);
        restorePage();
        if (resolution === "tombstone" && !partial)
          expect(testSessionStorage.getItem(key)).toBe("[0]");
        hidePage();
        restoreRemoval();
      }
      buffer.dispose();
      expect(count).toHaveBeenCalledTimes(resolution === "adopt" ? 0 : 1);
    },
  );

  it.each([false, true])(
    "does not double-count a stale snapshot after handoff (dispatched: %s)",
    async (dispatched) => {
      vi.spyOn(diag, "warn").mockImplementation(() => {});
      const firstFetch = stubFetch(hang);
      const client = createClient({ sdkStats: { enabled: true } });
      const count = vi.spyOn(client.itemStats!, "countEnvelopes");
      hidePage();
      const originalWrite = testSessionStorage.setItem.bind(testSessionStorage);
      const write = vi
        .spyOn(testSessionStorage, "setItem")
        .mockImplementation(() => {
          throw new DOMException("Storage blocked", "SecurityError");
        })
        .mockImplementationOnce(originalWrite);
      const restoreStorage = blockStorage("removeItem");
      let original: Promise<ExportResult>;
      if (dispatched) beginUnloading();
      try {
        original = exportAsync(client, [envelope("dispatched")]);
      } finally {
        if (dispatched) endUnloading();
      }
      await vi.waitFor(() => expect(hanging).toHaveLength(1));
      if (!dispatched) {
        hanging.shift()!(new Response(null));
        await original;
        expect(count).not.toHaveBeenCalled();
      }
      write.mockRestore();
      restoreStorage();
      loadPage();
      const fetch = stubFetch();
      await createClient({ sdkStats: { enabled: true } }).forceFlush();
      expect(sentNames(fetch)[0]).toEqual(["dispatched"]);
      if (dispatched) hanging.shift()!(new Response(null));
      await original;
      firstFetch.mockResolvedValue(new Response(null));
      await client.shutdown();
      expect(count).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "defers released-buffer outcomes when both writing and removal fail (expired: %s)",
    async (expired) => {
      vi.spyOn(diag, "warn").mockImplementation(() => {});
      const firstFetch = stubFetch(
        () => new Response(null, { status: 503, headers: { "retry-after": "86400" } }),
      );
      const client = createClient({ sdkStats: { enabled: true } });
      const count = vi.spyOn(client.itemStats!, "countEnvelopes");
      await exportAsync(client, [envelope("pending")]);
      hidePage();
      const key = bufferKeys()[0];
      const record = testSessionStorage.getItem(key);
      const restoreStorage = blockStorage("setItem", "removeItem");

      if (expired)
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + MAX_SESSION_BUFFER_AGE_MS + 1);
      hidePage();
      expect(testSessionStorage.getItem(key)).toBe(record);
      expect(count.mock.calls.filter(([outcome]) => outcome === "Dropped")).toEqual([]);
      firstFetch.mockResolvedValue(new Response(null));
      await client.shutdown();
      loadPage();
      const fetch = stubFetch();
      await createClient({ sdkStats: { enabled: true } }).forceFlush();
      expect(fetch).not.toHaveBeenCalled();
      restoreStorage();
      loadPage();
      await createClient({ sdkStats: { enabled: true } }).forceFlush();
      expect(fetch).toHaveBeenCalledTimes(expired ? 1 : 2);
      expect(await reportedCounts(fetch)).toEqual({
        [expired ? "Item_Dropped_Count:DEPENDENCY:503" : "Item_Success_Count:DEPENDENCY"]: 1,
      });
      await client.shutdown();
      loadPage();
      await createClient({ sdkStats: { enabled: true } }).forceFlush();
      expect(fetch).toHaveBeenCalledTimes(expired ? 1 : 2);
      expect(count.mock.calls.filter(([outcome]) => outcome === "Dropped")).toEqual([]);
    },
  );

  it("counts legacy expired telemetry without inventing success or trusting malformed drop codes", async () => {
    const destination = `${TEST_INSTRUMENTATION_KEY}|${endpoint}`;
    const key = `${SESSION_BUFFER_KEY_PREFIX}${encodeURIComponent(destination)}|previous-page|legacy`;
    testSessionStorage.setItem(
      key,
      JSON.stringify([
        1,
        [Date.now() - MAX_SESSION_BUFFER_AGE_MS - 1, [envelope("legacy")]],
        [Date.now() - MAX_SESSION_BUFFER_AGE_MS - 1, [null, envelope("malformed-metadata")], [503]],
      ]),
    );
    const fetch = stubFetch();
    await createClient({ sdkStats: { enabled: true } }).forceFlush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(await reportedCounts(fetch)).toEqual({
      "Item_Dropped_Count:DEPENDENCY:CLIENT_EXCEPTION": 2,
    });
  });

  it("counts deferred batches once on expiry or disposal", () => {
    const buffer = new SessionBuffer("terminal-accounting");
    const expired = vi.fn();
    const disposed = vi.fn();
    const first = buffer.add('[{"name":"expired"}]');
    expect(buffer.retain(first, expired)).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + MAX_SESSION_BUFFER_AGE_MS + 1);
    const second = buffer.add('[{"name":"disposed"}]');
    expect(expired).toHaveBeenCalledOnce();
    expect(buffer.retain(second, disposed)).toBe(true);
    buffer.dispose();
    buffer.dispose();
    expect(expired).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
  });

  it("does not recreate its record when a request settles after disposal", () => {
    const buffer = new SessionBuffer("destination");
    const id = buffer.add('[{"name":"late"}]');
    buffer.dispose();
    buffer.settle(id, '[{"name":"late"}]', true);
    expect(bufferKeys()).toEqual([]);
  });
});
