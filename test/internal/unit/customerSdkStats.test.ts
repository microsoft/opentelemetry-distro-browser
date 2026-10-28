// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, SpanKind, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createCustomerSdkStats,
  type CustomerSdkStats,
  type AzureMonitorSdkStatsOptions,
} from "../../../src/exporter/customerSdkStats.js";
import { AzureMonitorLogRecordExporter } from "../../../src/exporter/log.js";
import { AzureMonitorSpanExporter } from "../../../src/exporter/trace.js";
import { Sender } from "../../../src/exporter/sender.js";
import { spanToEnvelopes } from "../../../src/exporter/spanUtils.js";
import { beginUnloading, endUnloading } from "../../../src/exporter/common.js";
import { MAX_SEND_ATTEMPTS, MAX_SHUTDOWN_WAIT_MS } from "../../../src/exporter/constants.js";
import { AzureMonitorExportClient } from "../../../src/exporter/base.js";
import type { AzureMonitorEnvelope, MetricData } from "../../../src/exporter/telemetryModels.js";
import { createReadableLogRecord, createReadableSpan } from "../../fixtures/telemetry.js";
import {
  TEST_INSTRUMENTATION_KEY,
  assertAzureMonitorEnvelope,
} from "../../fixtures/azureMonitor.js";
import { installFakeClock } from "../../fixtures/clock.js";
import {
  MAX_SESSION_BUFFER_LENGTH,
  sessionBufferStorage,
} from "../../../src/exporter/sessionBuffer.js";
import { setSessionStorage, testSessionStorage } from "../../fixtures/sessionStorageSetup.js";
import { isSdkIngestionUrl, rememberSdkIngestionUrl } from "../../../src/shared/globalOwnership.js";

const endpoint = "https://customer.example.test";
const connectionString = `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=${endpoint}`;
const owners: Array<{ shutdown(): Promise<void> }> = [];
const finishers: Array<() => void> = [];
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
  for (const finish of finishers.splice(0)) finish();
  await Promise.allSettled(owners.splice(0).map((owner) => owner.shutdown()));
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  diag.disable();
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

function request(kinds = [SpanKind.CLIENT]) {
  const envelopes = kinds.flatMap((kind) =>
    spanToEnvelopes(createReadableSpan({ kind }), TEST_INSTRUMENTATION_KEY),
  );
  return {
    envelopes,
    body: new TextEncoder().encode(JSON.stringify(envelopes)),
    contentType: "application/json",
  };
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

it.each([200, 503])(
  "flushes new counts after an in-flight HTTP %i report with at most one follow-up",
  async (status) => {
    const stats = create();
    const normal = fetch.getMockImplementation()!;
    let finish!: () => void;
    fetch.mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          finish = () => resolve(status === 200 ? normal(...args) : new Response(null, { status }));
        }),
    );
    stats.count("Success", "TRACE");
    const first = stats.forceFlush();
    stats.count("Success", "DEPENDENCY");
    const second = stats.forceFlush();
    const concurrent = stats.forceFlush();
    if (status === 503) fetch.mockResolvedValueOnce(new Response(null, { status }));
    finish();
    await Promise.all([first, second, concurrent]);
    expect(fetch).toHaveBeenCalledTimes(2);
    if (status === 200) {
      expect(totals()).toEqual({
        "Item_Success_Count:TRACE": 1,
        "Item_Success_Count:DEPENDENCY": 1,
      });
    } else {
      expect(diag.warn).toHaveBeenCalledTimes(2);
      await stats.forceFlush();
      expect(totals()).toEqual({
        "Item_Success_Count:TRACE": 1,
        "Item_Success_Count:DEPENDENCY": 1,
      });
    }
  },
);

it.each(["spans", "logs"] as const)(
  "includes completed %s exports when flushing behind an older stats report",
  async (signal) => {
    const options = { connectionString, sdkStats: { enabled: true } };
    const exporter =
      signal === "spans"
        ? new AzureMonitorSpanExporter(options)
        : new AzureMonitorLogRecordExporter(options);
    owners.push(exporter);
    const send = () =>
      new Promise<ExportResult>((resolve) => {
        if (exporter instanceof AzureMonitorSpanExporter)
          exporter.export([createReadableSpan()], resolve);
        else exporter.export([createReadableLogRecord()], resolve);
      });
    await send();
    const normal = fetch.getMockImplementation()!;
    let finish!: () => void;
    fetch.mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          finish = () => resolve(normal(...args));
        }),
    );
    const first = exporter.forceFlush();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await send();
    const second = exporter.forceFlush();
    await Promise.resolve();
    finish();
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(totals()).toEqual({
      [`Item_Success_Count:${signal === "spans" ? "DEPENDENCY" : "TRACE"}`]: 2,
    });
  },
);

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

it.each(["shutdown", "eviction", "storage"] as const)(
  "counts retained telemetry once when %s makes its loss terminal",
  async (removal) => {
    const client = new AzureMonitorExportClient({ connectionString, sdkStats: { enabled: true } });
    owners.push(client);
    fetch.mockResolvedValueOnce(
      new Response(null, { status: 503, headers: { "retry-after": "86400" } }),
    );
    await new Promise<ExportResult>((resolve) => client.export(request().envelopes, resolve));
    await client.forceFlush();
    expect(totals()).toEqual({});
    if (removal !== "shutdown") {
      if (removal === "storage")
        vi.spyOn(testSessionStorage, "setItem").mockImplementation(() => {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        });
      const large = {
        ...request().envelopes[0],
        tags: { large: "x".repeat(MAX_SESSION_BUFFER_LENGTH * 0.6) },
      };
      beginUnloading();
      try {
        for (let index = 0; index < (removal === "eviction" ? 2 : 1); index++)
          await new Promise<ExportResult>((resolve) => client.export([large], resolve));
      } finally {
        endUnloading();
      }
      await client.forceFlush();
      expect(totals()).toEqual({
        "Item_Dropped_Count:DEPENDENCY:503": 1,
        "Item_Dropped_Count:DEPENDENCY:PAYLOAD_TOO_LARGE": 1,
      });
    }
    await client.shutdown();
    await client.shutdown();
    expect(totals()).toEqual({
      "Item_Dropped_Count:DEPENDENCY:503": 1,
      ...(removal === "shutdown"
        ? {}
        : { "Item_Dropped_Count:DEPENDENCY:PAYLOAD_TOO_LARGE": removal === "eviction" ? 2 : 1 }),
    });
  },
);

it("reports only a retained partial response's retriable items during shutdown", async () => {
  const client = new AzureMonitorExportClient({ connectionString, sdkStats: { enabled: true } });
  owners.push(client);
  fetch.mockResolvedValueOnce(
    Response.json(
      {
        itemsReceived: 4,
        itemsAccepted: 1,
        errors: [
          { index: 1, statusCode: 503, message: "retry" },
          { index: 2, statusCode: 400, message: "invalid" },
          { index: 3, statusCode: 206, message: "Telemetry sampled out." },
        ],
      },
      { status: 206 },
    ),
  );
  beginUnloading();
  try {
    await new Promise<ExportResult>((resolve) =>
      client.export(
        request([SpanKind.CLIENT, SpanKind.SERVER, SpanKind.CLIENT, SpanKind.SERVER]).envelopes,
        resolve,
      ),
    );
  } finally {
    endUnloading();
  }
  await client.shutdown();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Dropped_Count:DEPENDENCY:400": 1,
    "Item_Dropped_Count:REQUEST:SAMPLING": 1,
    "Item_Dropped_Count:REQUEST:503": 1,
  });
});

it("does not count an in-flight batch as dropped when its buffer copy is evicted", async () => {
  const client = new AzureMonitorExportClient({ connectionString, sdkStats: { enabled: true } });
  owners.push(client);
  let finish!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const sending = new Promise<ExportResult>((resolve) =>
    client.export(request().envelopes, resolve),
  );
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const large = {
    ...request().envelopes[0],
    tags: { large: "x".repeat(MAX_SESSION_BUFFER_LENGTH * 0.6) },
  };
  beginUnloading();
  try {
    for (let index = 0; index < 2; index++)
      await new Promise<ExportResult>((resolve) => client.export([large], resolve));
  } finally {
    endUnloading();
    finish(new Response(null));
  }
  await sending;
  await client.shutdown();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Dropped_Count:DEPENDENCY:PAYLOAD_TOO_LARGE": 2,
  });
});

it.each([false, true])(
  "waits for all pending exports before reporting shutdown drops (callback throws: %s)",
  async (callbackThrows) => {
    const client = new AzureMonitorExportClient({ connectionString, sdkStats: { enabled: true } });
    owners.push(client);
    const completions: Array<(response: Response) => void> = [];
    for (let index = 0; index < 2; index++)
      fetch.mockImplementationOnce(() => new Promise((resolve) => completions.push(resolve)));
    const failure = new Error("callback failed");
    client.export(request().envelopes, () => {
      if (callbackThrows) throw failure;
    });
    client.export(request([SpanKind.SERVER]).envelopes, () => {});
    await vi.waitFor(() => expect(completions).toHaveLength(2));
    const stopped = vi.fn();
    const shutdown = client.shutdown().finally(stopped);
    const expected = callbackThrows
      ? expect(shutdown).rejects.toBe(failure)
      : expect(shutdown).resolves.toBeUndefined();
    completions[0](new Response(null));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(stopped).not.toHaveBeenCalled();
    completions[1](new Response(null, { status: 503, headers: { "retry-after": "86400" } }));
    await expected;
    expect(totals()).toEqual({
      "Item_Success_Count:DEPENDENCY": 1,
      "Item_Dropped_Count:REQUEST:503": 1,
    });
  },
);

it.each(["available", "disabled", "unavailable", "quota", "oversized"] as const)(
  "reports unload size-limit drops only when storage does not retain them: %s",
  async (storage) => {
    const options = { connectionString, sdkStats: { enabled: true } };
    if (storage === "disabled") sessionBufferStorage.set(options, null);
    if (storage === "unavailable") setSessionStorage(undefined);
    if (storage === "quota")
      vi.spyOn(testSessionStorage, "setItem").mockImplementation(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      });
    const client = new AzureMonitorExportClient(options);
    owners.push(client);
    const envelopes = request().envelopes;
    const large = {
      ...envelopes[0],
      data: {
        baseType: "MessageData" as const,
        baseData: {
          ver: 2 as const,
          message: "x".repeat(storage === "oversized" ? MAX_SESSION_BUFFER_LENGTH : 70_000),
        },
      },
    };
    beginUnloading();
    try {
      const result = await new Promise<ExportResult>((resolve) =>
        client.export([envelopes[0], large], resolve),
      );
      expect(result.code).toBe(ExportResultCode.FAILED);
      await client.forceFlush();
    } finally {
      endUnloading();
    }
    expect(totals()).toEqual({
      ...(storage === "available" ? {} : { "Item_Dropped_Count:TRACE:PAYLOAD_TOO_LARGE": 1 }),
      "Item_Success_Count:DEPENDENCY": 1,
    });
  },
);

it("does not adopt an export callback's never-settling return value", async () => {
  const clock = installFakeClock();
  const client = new AzureMonitorExportClient({ connectionString, sdkStats: { enabled: true } });
  owners.push(client);
  const callback = vi.fn(() => new Promise<void>((resolve) => finishers.push(resolve)));
  client.export(request().envelopes, callback);
  const stopped = vi.fn();
  const shutdown = client.shutdown().then(stopped);
  await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce());
  await shutdown;
  expect(callback).toHaveBeenCalledOnce();
  expect(totals()).toEqual({ "Item_Success_Count:DEPENDENCY": 1 });
  await clock.advance(MAX_SHUTDOWN_WAIT_MS);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([false, true])(
  "cancels a hung export at the shutdown deadline and completes final accounting (callback throws: %s)",
  async (callbackThrows) => {
    const clock = installFakeClock();
    const client = new AzureMonitorExportClient({ connectionString, sdkStats: { enabled: true } });
    owners.push(client);
    let finish!: (response: Response) => void;
    fetch.mockResolvedValueOnce(new Response(null)).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const callbackFailure = new Error("callback failed");
    client.export(request().envelopes, () => {
      if (callbackThrows) throw callbackFailure;
    });
    const callback = vi.fn();
    client.export(request([SpanKind.SERVER]).envelopes, callback);
    const stopped = vi.fn();
    const shutdown = client.shutdown();
    expect(client.shutdown()).toBe(shutdown);
    const result = shutdown
      .then(
        () => undefined,
        (error: unknown) => error,
      )
      .finally(stopped);
    await clock.advance(MAX_SHUTDOWN_WAIT_MS - 1);
    expect(stopped).not.toHaveBeenCalled();
    expect(fetch.mock.calls[1][1]?.signal?.aborted).toBe(false);
    expect(fetch.mock.calls[1][1]?.credentials).toBeUndefined();
    expect(fetch.mock.calls[1][1]?.referrerPolicy).toBeUndefined();
    await clock.advance(1);
    const error = await result;
    const errors: unknown[] = error instanceof AggregateError ? error.errors : [error];
    expect(errors).toContainEqual(
      expect.objectContaining({ message: "Exporter shutdown timed out." }),
    );
    if (callbackThrows) expect(errors).toContain(callbackFailure);
    expect(fetch.mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      code: ExportResultCode.FAILED,
      error: expect.objectContaining({ name: "AbortError" }),
    });
    expect(totals()).toEqual({
      "Item_Success_Count:DEPENDENCY": 1,
      "Item_Dropped_Count:REQUEST:CLIENT_EXCEPTION": 1,
    });
    const sent = fetch.mock.calls.length;
    finish(new Response(null));
    await clock.advance(MAX_SHUTDOWN_WAIT_MS);
    await client.forceFlush();
    expect(fetch).toHaveBeenCalledTimes(sent);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["available", "disabled", "unavailable", "quota"] as const)(
  "counts only terminal outcomes from a partial unload with %s storage",
  async (storage) => {
    const options = { connectionString, sdkStats: { enabled: true } };
    if (storage === "disabled") sessionBufferStorage.set(options, null);
    if (storage === "unavailable") setSessionStorage(undefined);
    const client = new AzureMonitorExportClient(options);
    owners.push(client);
    fetch.mockImplementationOnce(async () => {
      if (storage === "quota")
        vi.spyOn(testSessionStorage, "setItem").mockImplementation(() => {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        });
      return Response.json(
        {
          itemsReceived: 4,
          itemsAccepted: 1,
          errors: [
            { index: 1, statusCode: 503, message: "retry" },
            { index: 2, statusCode: 400, message: "invalid" },
            { index: 3, statusCode: 206, message: "Telemetry sampled out." },
          ],
        },
        { status: 206 },
      );
    });
    beginUnloading();
    try {
      const result = await new Promise<ExportResult>((resolve) =>
        client.export(
          request([SpanKind.CLIENT, SpanKind.SERVER, SpanKind.CLIENT, SpanKind.SERVER]).envelopes,
          resolve,
        ),
      );
      expect(result.code).toBe(ExportResultCode.FAILED);
    } finally {
      endUnloading();
    }
    await client.forceFlush();
    expect(totals()).toEqual({
      "Item_Success_Count:DEPENDENCY": 1,
      "Item_Dropped_Count:DEPENDENCY:400": 1,
      "Item_Dropped_Count:REQUEST:SAMPLING": 1,
      ...(storage === "available" ? {} : { "Item_Dropped_Count:REQUEST:503": 1 }),
    });
  },
);

it.each(["body", "retry"] as const)(
  "cancels a pending %s at the shutdown deadline without leaving timers or dispatching a retry",
  async (phase) => {
    const clock = installFakeClock();
    const client = new AzureMonitorExportClient({ connectionString, sdkStats: { enabled: true } });
    owners.push(client);
    const response = new Response(null, { status: 503, headers: { "retry-after": "30" } });
    vi.spyOn(response, "text").mockImplementation(() =>
      phase === "body" ? new Promise(() => {}) : Promise.resolve(""),
    );
    fetch.mockResolvedValueOnce(response);
    const callback = vi.fn();
    client.export(request().envelopes, callback);
    const shutdown = expect(client.shutdown()).rejects.toThrow("shutdown timed out");
    await clock.advance(MAX_SHUTDOWN_WAIT_MS);
    await shutdown;
    expect(callback).toHaveBeenCalledOnce();
    expect(totals()).toEqual({
      [`Item_Dropped_Count:DEPENDENCY:${phase === "retry" ? "503" : "CLIENT_EXCEPTION"}`]: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["spans", "logs"] as const)(
  "reports conversion failures for %s without losing the callback",
  async (signal) => {
    const options = { connectionString, sdkStats: { enabled: true } };
    const exporter =
      signal === "spans"
        ? new AzureMonitorSpanExporter(options)
        : new AzureMonitorLogRecordExporter(options);
    owners.push(exporter);
    const failure = new Error("conversion failed");
    const callback = vi.fn();
    if (exporter instanceof AzureMonitorSpanExporter) {
      const span = createReadableSpan();
      Object.defineProperty(span, "startTime", {
        get: () => {
          throw failure;
        },
      });
      exporter.export([span], callback);
    } else {
      const log = createReadableLogRecord();
      Object.defineProperty(log, "hrTime", {
        get: () => {
          throw failure;
        },
      });
      exporter.export([log], callback);
    }
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      code: ExportResultCode.FAILED,
      error: failure,
    });
    await exporter.forceFlush();
    expect(totals()).toEqual({
      [`Item_Dropped_Count:${signal === "spans" ? "DEPENDENCY" : "TRACE"}:CLIENT_EXCEPTION`]: 1,
    });
  },
);

it.each(
  (["spans", "logs"] as const).flatMap((signal) =>
    [false, true].map((enabled) => ({ signal, enabled })),
  ),
)(
  "preserves the callback and remaining $signal counts when classification throws (stats: $enabled)",
  async ({ signal, enabled }) => {
    const options = { connectionString, sdkStats: { enabled } };
    const exporter =
      signal === "spans"
        ? new AzureMonitorSpanExporter(options)
        : new AzureMonitorLogRecordExporter(options);
    owners.push(exporter);
    const failure = new Error("classification failed");
    const broken = {
      get: () => {
        throw failure;
      },
    };
    const callback = vi.fn();
    expect(() => {
      if (exporter instanceof AzureMonitorSpanExporter) {
        const span = createReadableSpan();
        Object.defineProperty(span, "kind", broken);
        exporter.export([span, span, createReadableSpan({ kind: SpanKind.SERVER })], callback);
      } else {
        const log = createReadableLogRecord();
        Object.defineProperty(log.attributes, "exception.type", broken);
        exporter.export([log, log, createReadableLogRecord()], callback);
      }
    }).not.toThrow();
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      code: ExportResultCode.FAILED,
      error: failure,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(diag.warn).toHaveBeenCalledTimes(enabled ? 2 : 0);
    await exporter.forceFlush();
    expect(totals()).toEqual(
      enabled
        ? { [`Item_Dropped_Count:${signal === "spans" ? "REQUEST" : "TRACE"}:CLIENT_EXCEPTION`]: 1 }
        : {},
    );
  },
);

it.each([false, true])(
  "counts every converted span envelope before a later conversion failure (unloading: %s)",
  async (unloading) => {
    const exporter = new AzureMonitorSpanExporter({
      connectionString,
      sdkStats: { enabled: true },
    });
    owners.push(exporter);
    const converted = createReadableSpan({
      events: [
        {
          name: "exception",
          time: [1_735_689_601, 0],
          attributes: { "exception.type": "Error", "exception.message": "boom" },
          droppedAttributesCount: 0,
        },
        { name: "step", time: [1_735_689_602, 0], droppedAttributesCount: 0 },
      ],
    });
    const failed = createReadableSpan({ kind: SpanKind.SERVER });
    const failure = new Error("conversion failed");
    Object.defineProperty(failed, "startTime", {
      get: () => {
        throw failure;
      },
    });
    const callback = vi.fn();
    if (unloading) beginUnloading();
    try {
      exporter.export([converted, failed, createReadableSpan()], callback);
    } finally {
      if (unloading) endUnloading();
    }
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      code: ExportResultCode.FAILED,
      error: failure,
    });
    expect(fetch).not.toHaveBeenCalled();
    await exporter.forceFlush();
    expect(totals()).toEqual({
      "Item_Dropped_Count:DEPENDENCY:CLIENT_EXCEPTION": 2,
      "Item_Dropped_Count:REQUEST:CLIENT_EXCEPTION": 1,
      "Item_Dropped_Count:EXCEPTION:CLIENT_EXCEPTION": 1,
      "Item_Dropped_Count:TRACE:CLIENT_EXCEPTION": 1,
    });
  },
);

it("counts the discarded page-view performance envelope without counting filtered SDK timings", async () => {
  const exporter = new AzureMonitorLogRecordExporter({
    connectionString,
    sdkStats: { enabled: true },
  });
  owners.push(exporter);
  const converted = createReadableLogRecord({
    eventName: "browser.page_view",
    attributes: {
      "browser.page_view.performance.total": 170,
      "browser.page_view.performance.network_connect": 20,
      "browser.page_view.performance.sent_request": 50,
      "browser.page_view.performance.received_response": 30,
      "browser.page_view.performance.dom_processing": 70,
    },
  });
  const failed = createReadableLogRecord({ eventName: "application.event" });
  const failure = new Error("conversion failed");
  Object.defineProperty(failed, "hrTime", {
    get: () => {
      throw failure;
    },
  });
  const timing = createReadableLogRecord({
    eventName: "browser.resource_timing",
    instrumentationScope: { name: "@opentelemetry/browser-instrumentation/resource-timing" },
    attributes: { "url.full": `${endpoint}/v2/track` },
  });
  const callback = vi.fn();
  exporter.export([timing, converted, failed, timing, createReadableLogRecord()], callback);
  expect(callback).toHaveBeenCalledExactlyOnceWith({
    code: ExportResultCode.FAILED,
    error: failure,
  });
  expect(fetch).not.toHaveBeenCalled();
  await exporter.forceFlush();
  expect(totals()).toEqual({
    "Item_Dropped_Count:PAGE_VIEW:CLIENT_EXCEPTION": 2,
    "Item_Dropped_Count:CUSTOM_EVENT:CLIENT_EXCEPTION": 1,
    "Item_Dropped_Count:TRACE:CLIENT_EXCEPTION": 1,
  });
});

it("preserves filtering and the original failure when log eligibility and diagnostics throw", async () => {
  const exporter = new AzureMonitorLogRecordExporter({
    connectionString,
    sdkStats: { enabled: true },
  });
  owners.push(exporter);
  const failure = new Error("event name unavailable");
  const broken = createReadableLogRecord();
  Object.defineProperty(broken, "eventName", {
    get: () => {
      throw failure;
    },
  });
  const timing = createReadableLogRecord({
    eventName: "browser.resource_timing",
    instrumentationScope: { name: "@opentelemetry/browser-instrumentation/resource-timing" },
    attributes: { "url.full": `${endpoint}/v2/track` },
  });
  vi.spyOn(diag, "warn").mockImplementation(() => {
    throw new Error("diagnostic failed");
  });
  const callback = vi.fn();
  exporter.export([timing, broken, timing, createReadableLogRecord()], callback);
  expect(callback).toHaveBeenCalledExactlyOnceWith({
    code: ExportResultCode.FAILED,
    error: failure,
  });
  await exporter.forceFlush();
  expect(totals()).toEqual({ "Item_Dropped_Count:TRACE:CLIENT_EXCEPTION": 1 });
});

it.each([false, true])(
  "counts only eligible records when conversion fails with SDK timing first: %s",
  async (timingFirst) => {
    const exporter = new AzureMonitorLogRecordExporter({
      connectionString,
      sdkStats: { enabled: true },
    });
    owners.push(exporter);
    const timing = createReadableLogRecord({
      eventName: "browser.resource_timing",
      instrumentationScope: {
        name: "@opentelemetry/browser-instrumentation/resource-timing",
      },
      attributes: { "url.full": `${endpoint}/v2/track` },
    });
    const record = createReadableLogRecord();
    const failure = new Error("conversion failed");
    Object.defineProperty(record, "hrTime", {
      get: () => {
        throw failure;
      },
    });
    const callback = vi.fn();
    exporter.export(timingFirst ? [timing, record] : [record, timing], callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      code: ExportResultCode.FAILED,
      error: failure,
    });
    expect(fetch).not.toHaveBeenCalled();
    await exporter.forceFlush();
    expect(totals()).toEqual({ "Item_Dropped_Count:TRACE:CLIENT_EXCEPTION": 1 });
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it.each([
  { duration: 0, type: "CUSTOM_METRIC" },
  { duration: 123.5, type: "CUSTOM_METRIC" },
  { duration: -1, type: "CUSTOM_EVENT" },
  { duration: NaN, type: "CUSTOM_EVENT" },
  { duration: Infinity, type: "CUSTOM_EVENT" },
  { duration: "123", type: "CUSTOM_EVENT" },
])(
  "classifies page-visit conversion failures as $type for duration $duration",
  async ({ duration, type }) => {
    const exporter = new AzureMonitorLogRecordExporter({
      connectionString,
      sdkStats: { enabled: true },
    });
    owners.push(exporter);
    const record = createReadableLogRecord({
      eventName: "browser.page_visit",
      attributes: { "browser.page_visit.duration": duration },
    });
    const failure = new Error("conversion failed");
    Object.defineProperty(record, "hrTime", {
      get: () => {
        throw failure;
      },
    });
    const callback = vi.fn();
    exporter.export([record], callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith({
      code: ExportResultCode.FAILED,
      error: failure,
    });
    await exporter.forceFlush();
    expect(totals()).toEqual({ [`Item_Dropped_Count:${type}:CLIENT_EXCEPTION`]: 1 });
  },
);

it.each(["spans", "logs"] as const)(
  "counts %s exporter delivery once and stays silent without more telemetry",
  async (signal) => {
    const options = { connectionString, sdkStats: { enabled: true } };
    const exporter =
      signal === "spans"
        ? new AzureMonitorSpanExporter(options)
        : new AzureMonitorLogRecordExporter(options);
    owners.push(exporter);
    const result = await new Promise<ExportResult>((resolve) => {
      if (exporter instanceof AzureMonitorSpanExporter)
        exporter.export([createReadableSpan()], resolve);
      else exporter.export([createReadableLogRecord()], resolve);
    });
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    await exporter.forceFlush();
    await exporter.forceFlush();
    expect(totals()).toEqual({
      [`Item_Success_Count:${signal === "spans" ? "DEPENDENCY" : "TRACE"}`]: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  },
);

it("counts actual retry subsets, permanent failures and server sampling without recounting accepted items", async () => {
  const stats = create();
  const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
  fetch.mockResolvedValueOnce(
    Response.json(
      {
        itemsReceived: 5,
        itemsAccepted: 1,
        errors: [
          { index: 1, statusCode: 503, message: "retry" },
          { index: 2, statusCode: 400, message: "invalid" },
          { index: 3, statusCode: 206, message: "Telemetry sampled out." },
          { index: 4, statusCode: 429, message: "retry" },
        ],
      },
      { status: 206 },
    ),
  );
  await sender.send(
    request([SpanKind.CLIENT, SpanKind.SERVER, SpanKind.CLIENT, SpanKind.SERVER, SpanKind.CLIENT]),
  );
  await stats.forceFlush();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 2,
    "Item_Success_Count:REQUEST": 1,
    "Item_Dropped_Count:DEPENDENCY:400": 1,
    "Item_Dropped_Count:REQUEST:SAMPLING": 1,
    "Item_Retry_Count:REQUEST:503": 1,
    "Item_Retry_Count:DEPENDENCY:429": 1,
  });
});

it("replaces per-item retry codes after a later transport failure", async () => {
  const stats = create();
  const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
  fetch
    .mockResolvedValueOnce(
      Response.json(
        {
          itemsReceived: 3,
          itemsAccepted: 1,
          errors: [
            { index: 1, statusCode: 503, message: "retry" },
            { index: 2, statusCode: 429, message: "retry" },
          ],
        },
        { status: 206 },
      ),
    )
    .mockRejectedValueOnce(new TypeError("offline"));
  await sender.send(request([SpanKind.CLIENT, SpanKind.SERVER, SpanKind.CLIENT]));
  await stats.forceFlush();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 2,
    "Item_Success_Count:REQUEST": 1,
    "Item_Retry_Count:REQUEST:503": 1,
    "Item_Retry_Count:DEPENDENCY:429": 1,
    "Item_Retry_Count:REQUEST:CLIENT_EXCEPTION": 1,
    "Item_Retry_Count:DEPENDENCY:CLIENT_EXCEPTION": 1,
  });
});

it.each([false, true])(
  "counts rejected retry promises but not synchronous fetch throws (synchronous: %s)",
  async (synchronous) => {
    const stats = create();
    const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fetch.mockImplementationOnce(() => {
      const error = new TypeError("fetch wrapper failed");
      if (synchronous) throw error;
      return Promise.reject(error);
    });
    await sender.send(request());
    await stats.forceFlush();
    expect(totals()).toEqual({
      "Item_Success_Count:DEPENDENCY": 1,
      "Item_Retry_Count:DEPENDENCY:CLIENT_EXCEPTION": 1,
      ...(synchronous ? {} : { "Item_Retry_Count:DEPENDENCY:503": 1 }),
    });
  },
);

it.each(["HTTP", "network"] as const)(
  "counts exhausted %s retries and the final drop exactly once",
  async (failure) => {
    const stats = create();
    const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
    for (let index = 0; index < MAX_SEND_ATTEMPTS; index++) {
      if (failure === "HTTP") fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
      else fetch.mockRejectedValueOnce(new TypeError("offline"));
    }
    if (failure === "HTTP") await sender.send(request());
    else await expect(sender.send(request())).rejects.toThrow("offline");
    await stats.forceFlush();
    const code = failure === "HTTP" ? "503" : "CLIENT_EXCEPTION";
    expect(totals()).toEqual({
      [`Item_Retry_Count:DEPENDENCY:${code}`]: MAX_SEND_ATTEMPTS - 1,
      [`Item_Dropped_Count:DEPENDENCY:${code}`]: 1,
    });
  },
);

it("does not count a retry that the wait budget prevents and retains prior partial success", async () => {
  const stats = create();
  const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
  fetch.mockResolvedValueOnce(
    Response.json(
      {
        itemsReceived: 2,
        itemsAccepted: 1,
        errors: [{ index: 1, statusCode: 503, message: "retry" }],
      },
      { status: 206, headers: { "retry-after": "86400" } },
    ),
  );
  await expect(sender.send(request([SpanKind.CLIENT, SpanKind.SERVER]))).rejects.toThrow(
    "retry-wait budget",
  );
  await stats.forceFlush();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Dropped_Count:REQUEST:503": 1,
  });
});

it.each(["handoff", "abort"] as const)(
  "does not count a retry cancelled by %s during compression",
  async (cancellation) => {
    const stats = create();
    let active = true;
    let compressions = 0;
    const controller = new AbortController();
    vi.stubGlobal(
      "CompressionStream",
      class extends TransformStream<Uint8Array, Uint8Array> {
        constructor() {
          super({
            transform(chunk, stream) {
              if (++compressions === 2) {
                if (cancellation === "abort") controller.abort();
                else active = false;
              }
              stream.enqueue(chunk);
            },
          });
        }
      },
    );
    const transport = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 503 }),
    );
    const sender = new Sender({
      endpoint: "https://dc.services.visualstudio.com/v2/track",
      fetch: transport,
      itemStats: stats,
      delay: async () => {},
    });
    await expect(
      sender.send({ ...request(), active: () => active, signal: controller.signal }),
    ).rejects.toThrow(cancellation === "abort" ? "Request aborted" : "handed off");
    expect(compressions).toBe(2);
    expect(transport).toHaveBeenCalledOnce();
    await stats.forceFlush();
    expect(totals()).toEqual(
      cancellation === "handoff" ? {} : { "Item_Dropped_Count:DEPENDENCY:CLIENT_EXCEPTION": 1 },
    );
  },
);

it.each(
  [200, 400].flatMap((status) =>
    ["retry", "once", "unload"].flatMap((mode) =>
      [Error, TypeError].map((ErrorType) => ({ status, mode, ErrorType, error: ErrorType.name })),
    ),
  ),
)(
  "preserves HTTP $status item outcomes after a body $error in $mode mode",
  async ({ status, mode, ErrorType }) => {
    const stats = create();
    const failure = new ErrorType("body failed");
    const response = new Response(null, { status });
    vi.spyOn(response, "text").mockRejectedValue(failure);
    fetch.mockResolvedValueOnce(response);
    const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
    await expect(
      sender.send({ ...request(), retry: mode !== "once", unloading: mode === "unload" }),
    ).rejects.toBe(failure);
    expect(fetch).toHaveBeenCalledOnce();
    await stats.forceFlush();
    expect(totals()).toEqual({
      [status === 200 ? "Item_Success_Count:DEPENDENCY" : "Item_Dropped_Count:DEPENDENCY:400"]: 1,
    });
  },
);

it("counts only the retry subset when its successful response body fails", async () => {
  const stats = create();
  const response = new Response(null);
  vi.spyOn(response, "text").mockRejectedValue(new TypeError("body failed"));
  fetch
    .mockResolvedValueOnce(
      Response.json(
        {
          itemsReceived: 2,
          itemsAccepted: 1,
          errors: [{ index: 1, statusCode: 503, message: "retry" }],
        },
        { status: 206 },
      ),
    )
    .mockResolvedValueOnce(response);
  const sender = new Sender({ endpoint, itemStats: stats, delay: async () => {} });
  await expect(sender.send(request([SpanKind.CLIENT, SpanKind.SERVER]))).rejects.toThrow(
    "body failed",
  );
  await stats.forceFlush();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Success_Count:REQUEST": 1,
    "Item_Retry_Count:REQUEST:503": 1,
  });
});

it.each([
  {
    itemsReceived: 2,
    itemsAccepted: 1,
    errors: [{ index: 5, statusCode: 503, message: "bad index" }],
  },
  {
    itemsReceived: 2,
    itemsAccepted: 0,
    errors: [
      { index: 0, statusCode: 503, message: "" },
      { index: 0, statusCode: 503, message: "" },
    ],
  },
  { itemsReceived: 2, itemsAccepted: 9, errors: [] },
])(
  "does not invent successes or duplicate retries from malformed partial responses: %j",
  async (body) => {
    const stats = create();
    const sender = new Sender({ endpoint, itemStats: stats });
    fetch.mockResolvedValueOnce(Response.json(body, { status: 206 }));
    await sender.send(request([SpanKind.CLIENT, SpanKind.CLIENT]));
    await stats.forceFlush();
    expect(totals()).toEqual({ "Item_Dropped_Count:DEPENDENCY:206": 2 });
  },
);

it("counts unload transport failures as drops and beacon queueing as success without retries", async () => {
  const stats = create();
  const beacon = vi.fn(() => true);
  const sender = new Sender({ endpoint, itemStats: stats, sendBeacon: beacon });
  fetch.mockRejectedValueOnce(new TypeError("keepalive unavailable"));
  await sender.send({ ...request(), unloading: true });
  beacon.mockReturnValueOnce(false);
  fetch.mockRejectedValueOnce(new TypeError("keepalive unavailable"));
  await expect(sender.send({ ...request(), unloading: true })).rejects.toThrow("could not queue");
  await stats.forceFlush();
  expect(totals()).toEqual({
    "Item_Success_Count:DEPENDENCY": 1,
    "Item_Dropped_Count:DEPENDENCY:CLIENT_EXCEPTION": 1,
  });
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

it.each([
  { name: "simple", Processor: SimpleLogRecordProcessor },
  { name: "batch", Processor: BatchLogRecordProcessor },
])(
  "does not feed diagnostics into standalone $name processors without a context manager",
  async ({ Processor }) => {
    context.disable();
    const exporter = new AzureMonitorLogRecordExporter({
      connectionString,
      sdkStats: { enabled: true },
    });
    const provider = new LoggerProvider({ processors: [new Processor({ exporter })] });
    owners.push(provider);
    const instrumentation = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
    instrumentation.setLoggerProvider(provider);
    instrumentation.enable();
    finishers.push(() => instrumentation.disable());
    const wrappedWarn = console.warn;
    vi.spyOn(diag, "warn").mockImplementation((...args) => console.warn(...args));
    provider.getLogger("app").emit({ body: "application" });
    fetch
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    await provider.forceFlush();
    await exporter.forceFlush();
    await provider.forceFlush();
    await exporter.forceFlush();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(diag.warn).toHaveBeenCalledOnce();
    expect(console.warn).toBe(wrappedWarn);
    console.warn("application warning");
    await provider.forceFlush();
    await exporter.forceFlush();
    expect(totals()).toEqual({ "Item_Success_Count:TRACE": 1 });
    expect(fetch).toHaveBeenCalledTimes(4);
  },
);

it.each([false, true])(
  "filters only exact shared configured and redirect URLs in standalone logs when enabled: %s",
  async (enabled) => {
    const configured = "https://standalone-filter.example.test/v2/track";
    const redirected = "https://standalone-filter.example.test/ingest?tenant=one";
    const response = new Response(null);
    Object.defineProperties(response, {
      redirected: { value: true },
      url: { value: redirected },
    });
    const peer = new Sender({
      endpoint: configured,
      fetch: async () => response,
    });
    await peer.send(request());
    const exporter = new AzureMonitorLogRecordExporter({
      connectionString,
      sdkStats: { enabled },
    });
    owners.push(exporter);
    const timing = (url: string) =>
      createReadableLogRecord({
        eventName: "browser.resource_timing",
        instrumentationScope: {
          name: "@opentelemetry/browser-instrumentation/resource-timing",
        },
        attributes: { "url.full": url },
      });
    const records = [
      timing(configured),
      timing(redirected),
      timing(`${configured}?application=true`),
      timing("https://standalone-filter.example.test/application"),
      timing("https://unconfigured.services.visualstudio.com/v2/track"),
      { ...timing(configured), instrumentationScope: { name: "application" } },
      { ...timing(redirected), eventName: "application.event" },
    ];
    const result = await new Promise<ExportResult>((resolve) => exporter.export(records, resolve));
    expect(result.code).toBe(ExportResultCode.SUCCESS);
    const [url, init] = fetch.mock.calls[0];
    const envelopes: AzureMonitorEnvelope[] = await new Request(url, init).json();
    expect(envelopes).toHaveLength(enabled ? 5 : 7);
    expect(envelopes.map((envelope) => envelope.data.baseData.properties?.["url.full"])).toEqual(
      records.slice(enabled ? 2 : 0).map((record) => record.attributes["url.full"]),
    );
    await exporter.forceFlush();
    expect(totals()).toEqual(enabled ? { "Item_Success_Count:CUSTOM_EVENT": 5 } : {});
  },
);

it.each([false, true])(
  "constructs standalone exporters beside an incompatible distribution registry (stats: %s)",
  async (enabled) => {
    const key = Symbol.for("@microsoft/opentelemetry-browser");
    const realm = globalThis as typeof globalThis & { [key: symbol]: unknown };
    const previous = Object.getOwnPropertyDescriptor(realm, key);
    const incompatible = { version: 2 };
    realm[key] = incompatible;
    try {
      const options = { connectionString, sdkStats: { enabled } };
      const spans = new AzureMonitorSpanExporter(options);
      owners.push(spans);
      const logExporter = new AzureMonitorLogRecordExporter(options);
      owners.push(logExporter);
      await expect(
        new Promise<ExportResult>((resolve) => spans.export([createReadableSpan()], resolve)),
      ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      await expect(
        new Promise<ExportResult>((resolve) =>
          logExporter.export(
            [
              createReadableLogRecord({
                eventName: "browser.resource_timing",
                instrumentationScope: {
                  name: "@opentelemetry/browser-instrumentation/resource-timing",
                },
                attributes: { "url.full": `${endpoint}/v2/track` },
              }),
              createReadableLogRecord(),
            ],
            resolve,
          ),
        ),
      ).resolves.toEqual({ code: ExportResultCode.SUCCESS });
      const [url, init] = fetch.mock.calls[1];
      const envelopes: AzureMonitorEnvelope[] = await new Request(url, init).json();
      expect(envelopes).toHaveLength(enabled ? 1 : 2);
      await Promise.all([spans.forceFlush(), logExporter.forceFlush()]);
      expect(totals()).toEqual(
        enabled ? { "Item_Success_Count:DEPENDENCY": 1, "Item_Success_Count:TRACE": 1 } : {},
      );
      expect(realm[key]).toBe(incompatible);
    } finally {
      if (previous) Object.defineProperty(realm, key, previous);
      else delete realm[key];
    }
  },
);

it("bounds exact redirect URL history while retaining recent and refreshed destinations", async () => {
  const url = (index: number) => `https://redirect-history.example.test/track?request=${index}`;
  let index = 0;
  const sender = new Sender({
    endpoint: url(-1),
    fetch: async () => {
      const response = new Response(null);
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: url(index++) },
      });
      return response;
    },
  });
  for (let count = 0; count < 256; count++) await sender.send(request());
  expect(isSdkIngestionUrl(url(-1))).toBe(false);
  expect(isSdkIngestionUrl(url(0))).toBe(true);
  rememberSdkIngestionUrl(`${url(0)}#ignored`);
  await sender.send(request());
  expect(isSdkIngestionUrl(url(0))).toBe(true);
  expect(isSdkIngestionUrl(url(1))).toBe(false);
  expect(isSdkIngestionUrl(url(2))).toBe(true);
  expect(isSdkIngestionUrl(url(256))).toBe(true);
  expect(isSdkIngestionUrl(`${url(256)}&application=true`)).toBe(false);
  sender.dispose();
});

it.each([false, true])(
  "protects live shared destinations through redirect churn and releases them on shutdown (stats: %s)",
  async (enabled) => {
    const protectedEndpoint = `https://active-sdk-${enabled}.example.test`;
    const options = {
      connectionString: `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=${protectedEndpoint}`,
      sdkStats: { enabled },
    };
    const first = new AzureMonitorSpanExporter(options);
    const second = new AzureMonitorLogRecordExporter(options);
    owners.push(first, second);
    const collector = new AzureMonitorLogRecordExporter({
      connectionString,
      sdkStats: { enabled: true },
    });
    owners.push(collector);
    let index = 0;
    const peer = new Sender({
      endpoint: "https://churn.example.test/v2/track",
      fetch: async () => {
        const response = new Response(null);
        Object.defineProperties(response, {
          redirected: { value: true },
          url: { value: `https://churn.example.test/v2/track?request=${index++}` },
        });
        return response;
      },
    });
    try {
      for (let count = 0; count < 300; count++) await peer.send(request());
      const url = `${protectedEndpoint}/v2/track`;
      expect(isSdkIngestionUrl(url)).toBe(true);
      await first.shutdown();
      await first.shutdown();
      for (let count = 0; count < 300; count++) await peer.send(request());
      expect(isSdkIngestionUrl(url)).toBe(true);
      await new Promise<ExportResult>((resolve) =>
        collector.export(
          [
            createReadableLogRecord({
              eventName: "browser.resource_timing",
              instrumentationScope: {
                name: "@opentelemetry/browser-instrumentation/resource-timing",
              },
              attributes: { "url.full": url },
            }),
          ],
          resolve,
        ),
      );
      expect(fetch).not.toHaveBeenCalled();
      await second.shutdown();
      expect(isSdkIngestionUrl(url)).toBe(true);
      for (let count = 0; count < 300; count++) await peer.send(request());
      expect(isSdkIngestionUrl(url)).toBe(false);
    } finally {
      peer.dispose();
    }
  },
);

it("does not reactivate URL protection when a disposed sender receives a late redirect", async () => {
  const original = "https://late-sdk.example.test/v2/track";
  const redirected = "https://late-sdk.example.test/redirected";
  let finish!: (response: Response) => void;
  const sender = new Sender({
    endpoint: original,
    fetch: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const sending = sender.send(request());
  await vi.waitFor(() => expect(finish).toBeDefined());
  sender.dispose();
  const response = new Response(null);
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: redirected },
  });
  finish(response);
  await sending;
  expect(isSdkIngestionUrl(redirected)).toBe(true);
  for (let index = 0; index < 300; index++)
    rememberSdkIngestionUrl(`https://late-sdk-history.example.test/track?request=${index}`);
  expect(isSdkIngestionUrl(original)).toBe(false);
  expect(isSdkIngestionUrl(redirected)).toBe(false);
});

it.each([false, true])(
  "protects a concurrent attempt's original URL through redirects and churn (failure: %s)",
  async (failure) => {
    const original = `https://attempt-${failure}.example.test/v2/track`;
    const redirected = `https://attempt-${failure}.example.test/redirected`;
    let resolve!: (response: Response) => void;
    let reject!: (error: Error) => void;
    const transport = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((yes, no) => {
            resolve = yes;
            reject = no;
          }),
      )
      .mockImplementation(async () => {
        const response = new Response(null);
        Object.defineProperties(response, {
          redirected: { value: true },
          url: { value: redirected },
        });
        return response;
      });
    const sender = new Sender({ endpoint: original, fetch: transport });
    const pending = sender.send({ ...request(), retry: false });
    const expected = failure
      ? expect(pending).rejects.toThrow("Browser transport failed")
      : expect(pending).resolves.toMatchObject({ statusCode: 200 });
    await sender.send(request());
    const churn = () => {
      for (let index = 0; index < 300; index++)
        rememberSdkIngestionUrl(`https://attempt-history.example.test/track?request=${index}`);
    };
    churn();
    expect(isSdkIngestionUrl(original)).toBe(true);
    const collector = new AzureMonitorLogRecordExporter({
      connectionString,
      sdkStats: { enabled: true },
    });
    owners.push(collector);
    await new Promise<ExportResult>((callback) =>
      collector.export(
        [
          createReadableLogRecord({
            eventName: "browser.resource_timing",
            instrumentationScope: {
              name: "@opentelemetry/browser-instrumentation/resource-timing",
            },
            attributes: { "url.full": original },
          }),
        ],
        callback,
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
    if (failure) reject(new TypeError("offline"));
    else resolve(new Response(null));
    await expected;
    expect(isSdkIngestionUrl(original)).toBe(true);
    churn();
    expect(isSdkIngestionUrl(original)).toBe(false);
    expect(isSdkIngestionUrl(redirected)).toBe(true);
    sender.dispose();
  },
);
