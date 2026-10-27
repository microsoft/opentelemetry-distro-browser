// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createCustomerSdkStats,
  type CustomerSdkStats,
  type AzureMonitorSdkStatsOptions,
} from "../../../src/exporter/customerSdkStats.js";
import { beginUnloading, endUnloading } from "../../../src/exporter/common.js";
import type { AzureMonitorEnvelope, MetricData } from "../../../src/exporter/telemetryModels.js";
import {
  TEST_INSTRUMENTATION_KEY,
  assertAzureMonitorEnvelope,
} from "../../fixtures/azureMonitor.js";
import { installFakeClock } from "../../fixtures/clock.js";

const endpoint = "https://customer.example.test";
const owners: CustomerSdkStats[] = [];
let reports: AzureMonitorEnvelope<MetricData>[][];
let fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

beforeEach(() => {
  reports = [];
  vi.stubGlobal("CompressionStream", undefined);
  fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const envelopes: AzureMonitorEnvelope[] = JSON.parse(await new Request(url, init).text());
    if (envelopes.every((envelope) => envelope.data.baseType === "MetricData")) {
      reports.push(envelopes as AzureMonitorEnvelope<MetricData>[]);
    }
    return new Response(null);
  });
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(diag, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.allSettled(owners.splice(0).map((owner) => owner.shutdown()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function create(options: AzureMonitorSdkStatsOptions = { enabled: true }): CustomerSdkStats {
  const stats = createCustomerSdkStats(options, TEST_INSTRUMENTATION_KEY, endpoint);
  if (!stats) throw new Error("Expected enabled stats");
  owners.push(stats);
  return stats;
}

function totals() {
  const totals: Record<string, number> = {};
  for (const {
    data: { baseData },
  } of reports.flat()) {
    const { name, value } = baseData.metrics[0];
    const props = baseData.properties!;
    const key = [name, props.telemetryType, props.dropCode ?? props.retryCode]
      .filter(Boolean)
      .join(":");
    totals[key] = (totals[key] ?? 0) + value;
  }
  return totals;
}

it.each([undefined, {}, { enabled: false }])(
  "allocates no reporter without explicit opt-in: %j",
  (options) => {
    expect(createCustomerSdkStats(options, TEST_INSTRUMENTATION_KEY, endpoint)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  },
);

it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])(
  "rejects invalid interval %s even while disabled",
  (collectionIntervalMillis) => {
    expect(() =>
      createCustomerSdkStats({ collectionIntervalMillis }, TEST_INSTRUMENTATION_KEY, endpoint),
    ).toThrow(RangeError);
  },
);

it("reports customer metrics without identifiers, enrichment, application sampling or idle timers", async () => {
  const clock = installFakeClock();
  const stats = create();
  expect(vi.getTimerCount()).toBe(0);
  stats.count("Success", "DEPENDENCY", "", 4);
  stats.count("Dropped", "TRACE", "SAMPLING", 2);
  stats.count("Retry", "DEPENDENCY", "503", 3);
  await clock.advance(899_999);
  expect(fetch).not.toHaveBeenCalled();
  await clock.advance(1);
  await vi.waitFor(() => expect(reports).toHaveLength(1));
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 4,
    "Item_Dropped_Count:TRACE:SAMPLING": 2,
    "Item_Retry_Count:DEPENDENCY:503": 3,
  });
  for (const envelope of reports.flat()) {
    assertAzureMonitorEnvelope(envelope);
    expect(envelope.iKey).toBe(TEST_INSTRUMENTATION_KEY);
    expect(envelope.sampleRate).toBeUndefined();
    expect(Object.keys(envelope.tags)).toEqual(["ai.internal.sdkVersion"]);
  }
  expect(fetch.mock.calls[0]).toEqual([
    `${endpoint}/v2/track`,
    expect.objectContaining({
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    }),
  ]);
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await clock.advance(900_000);
  expect(fetch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([401, 403, 408, 429, 439, 500, 502, 503, 504, "network"] as const)(
  "retains a failed %s report until the next interval without counting its own failure",
  async (failure) => {
    const clock = installFakeClock();
    const stats = create({ enabled: true, collectionIntervalMillis: 10 });
    if (failure === "network") fetch.mockRejectedValueOnce(new TypeError("offline"));
    else fetch.mockResolvedValueOnce(new Response(null, { status: failure }));
    stats.count("Success", "TRACE", "", 4);
    await stats.forceFlush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(diag.warn).toHaveBeenCalledWith("Customer SDK stats export failed", expect.any(Error));
    await clock.advance(9);
    expect(fetch).toHaveBeenCalledOnce();
    await clock.advance(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await stats.forceFlush();
    expect(totals()).toEqual({ "Item_Success_Count:TRACE": 4 });
    await stats.shutdown();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([400, 413])("does not retain a permanently rejected HTTP %s report", async (status) => {
  const clock = installFakeClock();
  const stats = create({ enabled: true, collectionIntervalMillis: 10 });
  fetch.mockResolvedValueOnce(new Response(null, { status }));
  stats.count("Success", "TRACE");
  await stats.forceFlush();
  await clock.advance(10);
  await stats.shutdown();
  expect(fetch).toHaveBeenCalledOnce();
  expect(diag.warn).toHaveBeenCalledWith("Customer SDK stats export failed", expect.any(Error));
  expect(vi.getTimerCount()).toBe(0);
});

it.each([200, 400])(
  "does not replay HTTP %s counts when reading the response body fails",
  async (status) => {
    const clock = installFakeClock();
    const stats = create({ enabled: true, collectionIntervalMillis: 10 });
    const response = new Response(null, { status });
    vi.spyOn(response, "text").mockRejectedValueOnce(new TypeError("body failed"));
    fetch.mockResolvedValueOnce(response);
    stats.count("Success", "TRACE");
    await stats.forceFlush();
    await clock.advance(10);
    await stats.shutdown();
    expect(fetch).toHaveBeenCalledOnce();
    expect(diag.warn).toHaveBeenCalledWith("Customer SDK stats export failed", expect.any(Error));
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("merges failed counts with counts collected during a shared in-flight flush", async () => {
  const stats = create();
  let finish!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  stats.count("Success", "TRACE", "", 4);
  const first = stats.forceFlush();
  expect(stats.forceFlush()).toBe(first);
  stats.count("Success", "TRACE", "", 2);
  stats.count("Dropped", "DEPENDENCY", "SAMPLING", 3);
  finish(new Response(null, { status: 503 }));
  await first;
  expect(reports).toHaveLength(0);
  await stats.forceFlush();
  await stats.forceFlush();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(totals()).toEqual({
    "Item_Success_Count:TRACE": 6,
    "Item_Dropped_Count:DEPENDENCY:SAMPLING": 3,
  });
});

it("only retries outstanding retriable items after partial acceptance", async () => {
  const stats = create();
  fetch.mockResolvedValueOnce(
    Response.json(
      {
        itemsReceived: 4,
        itemsAccepted: 1,
        errors: [
          { index: 1, statusCode: 503, message: "unavailable" },
          { index: 2, statusCode: 400, message: "invalid" },
          { index: 3, statusCode: 206, message: "Telemetry sampled out." },
        ],
      },
      { status: 206 },
    ),
  );
  stats.count("Success", "TRACE", "", 4);
  stats.count("Retry", "DEPENDENCY", "503", 3);
  stats.count("Dropped", "TRACE", "400", 2);
  stats.count("Success", "REQUEST");
  const first = stats.forceFlush();
  stats.count("Success", "TRACE", "", 2);
  await first;
  await stats.forceFlush();
  await stats.forceFlush();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(totals()).toEqual({
    "Item_Success_Count:TRACE": 2,
    "Item_Retry_Count:DEPENDENCY:503": 3,
  });
});

it("retains all outstanding counts when a partial response cannot be parsed", async () => {
  const stats = create();
  fetch.mockResolvedValueOnce(new Response("unreadable", { status: 206 }));
  stats.count("Success", "TRACE", "", 4);
  await stats.forceFlush();
  await stats.forceFlush();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(totals()).toEqual({ "Item_Success_Count:TRACE": 4 });
});

it("keeps failed counts isolated from another reporter", async () => {
  const first = create();
  const second = create();
  fetch.mockRejectedValueOnce(new TypeError("offline"));
  first.count("Success", "TRACE", "", 4);
  second.count("Success", "DEPENDENCY", "", 2);
  await first.forceFlush();
  await second.forceFlush();
  expect(totals()).toEqual({ "Item_Success_Count:DEPENDENCY": 2 });
  await first.forceFlush();
  expect(totals()).toEqual({ "Item_Success_Count:DEPENDENCY": 2, "Item_Success_Count:TRACE": 4 });
});

it("shares concurrent flushes, retains new counts and drains them after a pending export at shutdown", async () => {
  const stats = create();
  const normal = fetch.getMockImplementation()!;
  let complete!: () => void;
  fetch.mockImplementationOnce(
    (...args) =>
      new Promise((resolve) => {
        complete = () => resolve(normal(...args));
      }),
  );
  stats.count("Success", "TRACE");
  const first = stats.forceFlush();
  expect(stats.forceFlush()).toBe(first);
  stats.count("Success", "DEPENDENCY");
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const shutdown = stats.shutdown(pending);
  expect(stats.shutdown()).toBe(shutdown);
  stats.count("Dropped", "TRACE", "400");
  finish();
  complete();
  await shutdown;
  stats.count("Success", "REQUEST");
  await stats.forceFlush();
  expect(reports).toHaveLength(2);
  expect(totals()).toEqual({
    "Item_Success_Count:TRACE": 1,
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Dropped_Count:TRACE:400": 1,
  });
});

it("retains timed-out counts for the next interval and aborts the stalled request", async () => {
  const clock = installFakeClock();
  fetch.mockImplementationOnce(() => new Promise(() => {}));
  const stats = create({ enabled: true, collectionIntervalMillis: 10 });
  stats.count("Success", "TRACE");
  const flushing = stats.forceFlush();
  await clock.advance(10_000);
  await flushing;
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(diag.warn).toHaveBeenCalledWith(
    "Customer SDK stats export failed",
    expect.objectContaining({ message: "Operation timed out." }),
  );
  await clock.advance(10);
  expect(fetch).toHaveBeenCalledTimes(2);
  await stats.forceFlush();
  expect(totals()).toEqual({ "Item_Success_Count:TRACE": 1 });
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "bounds shutdown to one final attempt after any in-flight report: %s",
  async (inFlight) => {
    const clock = installFakeClock();
    fetch.mockImplementation(() => new Promise(() => {}));
    const stats = create();
    stats.count("Success", "TRACE");
    if (inFlight) void stats.forceFlush();
    const shutdown = stats.shutdown();
    expect(stats.shutdown()).toBe(shutdown);
    await clock.advance(inFlight ? 20_000 : 10_000);
    await shutdown;
    expect(fetch).toHaveBeenCalledTimes(inFlight ? 2 : 1);
    expect(fetch.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    stats.count("Success", "TRACE");
    await stats.forceFlush();
    await clock.advance(900_000);
    expect(fetch).toHaveBeenCalledTimes(inFlight ? 2 : 1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("makes one final attempt for failed counts before discarding them at shutdown", async () => {
  const clock = installFakeClock();
  fetch.mockRejectedValue(new TypeError("offline"));
  const stats = create();
  stats.count("Success", "TRACE");
  await stats.forceFlush();
  await stats.shutdown();
  await clock.advance(900_000);
  await stats.forceFlush();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("re-arms pending counters when an interval expires during a slow report", async () => {
  const clock = installFakeClock();
  const stats = create({ enabled: true, collectionIntervalMillis: 10 });
  const normal = fetch.getMockImplementation()!;
  let finish!: () => void;
  fetch.mockImplementationOnce(
    (...args) =>
      new Promise((resolve) => {
        finish = () => resolve(normal(...args));
      }),
  );
  stats.count("Success", "TRACE");
  await clock.advance(10);
  stats.count("Success", "DEPENDENCY");
  await clock.advance(20);
  finish();
  await clock.advance(20);
  expect(totals()).toEqual({ "Item_Success_Count:TRACE": 1, "Item_Success_Count:DEPENDENCY": 1 });
  expect(vi.getTimerCount()).toBe(0);
});

it("reports customer stats with keepalive but never falls back to beacon", async () => {
  const stats = create();
  const beacon = vi.spyOn(navigator, "sendBeacon");
  stats.count("Success", "TRACE");
  fetch.mockRejectedValueOnce(new TypeError("keepalive unavailable"));
  beginUnloading();
  try {
    await stats.forceFlush();
  } finally {
    endUnloading();
  }
  expect(fetch.mock.calls[0][1]?.keepalive).toBe(true);
  expect(beacon).not.toHaveBeenCalled();
  await stats.forceFlush();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(totals()).toEqual({ "Item_Success_Count:TRACE": 1 });
});
