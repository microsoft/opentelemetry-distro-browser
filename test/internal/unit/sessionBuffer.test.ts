// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
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
} from "../../../src/exporter/sessionBuffer.js";
import { spanToEnvelope } from "../../../src/exporter/spanUtils.js";
import type { AzureMonitorEnvelope } from "../../../src/exporter/telemetryModels.js";
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
  beginUnloading();
  endUnloading();
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
    await expect(exportAsync(createClient(), [envelope("throttled")])).resolves.toMatchObject({
      code: ExportResultCode.FAILED,
    });
    hidePage();

    loadPage();
    const fetch = stubFetch();
    await createClient().forceFlush();
    expect(sentNames(fetch)).toEqual([["throttled"]]);
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

  it("reclaims a hidden page's telemetry on its next update once visible", async () => {
    let visibility: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const buffer = new SessionBuffer("destination");
    buffer.add('[{"name":"hidden"}]');
    expect(testSessionStorage.getItem(bufferKeys()[0])).toMatch(/^\[1,/);

    visibility = "visible";
    buffer.add('[{"name":"visible"}]');
    expect(testSessionStorage.getItem(bufferKeys()[0])).toMatch(/^\[0,/);
    buffer.dispose();
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

    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    expect(() => buffer.add('[{"name":"second"}]')).not.toThrow();
    expect(storage.length).toBe(0);
    expect(() => buffer.settle(first, "", false)).not.toThrow();
    buffer.dispose();
  });

  it("bounds buffered telemetry by length, evicting the oldest first", () => {
    const buffer = new SessionBuffer("destination");
    const body = (name: string): string =>
      `[{"name":"${name}","pad":"${"x".repeat(MAX_SESSION_BUFFER_LENGTH / 3)}"}]`;
    buffer.add(body("oldest"));
    buffer.add(body("middle"));
    buffer.add(body("newest"));

    const stored = testSessionStorage.getItem(bufferKeys()[0]) ?? "";
    expect(stored.length).toBeLessThanOrEqual(MAX_SESSION_BUFFER_LENGTH + 4);
    expect(stored).not.toContain("oldest");
    expect(stored).toContain("middle");
    expect(stored).toContain("newest");
    buffer.dispose();
  });

  it("discards expired and malformed records", () => {
    const destination = `${TEST_INSTRUMENTATION_KEY}|${endpoint}`;
    const prefix = `${SESSION_BUFFER_KEY_PREFIX}${destination}|old-page|`;
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
});
