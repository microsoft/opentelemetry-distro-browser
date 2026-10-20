// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { afterEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import type { AzureMonitorEnvelope } from "../../../src/exporter/telemetryModels.js";
import { installFakeClock } from "../../fixtures/clock.js";

const connectionString =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://customer.example.test";
const handles: MicrosoftOpenTelemetryBrowser[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.shutdown()));
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: () => void;
  const promise = new Promise<string>((done, fail) => {
    resolve = done;
    reject = () => fail(new Error("private reason"));
  });
  return { promise, resolve, reject };
}

async function start(options: MicrosoftOpenTelemetryBrowserOptions) {
  const bodies: Promise<AzureMonitorEnvelope[]>[] = [];
  vi.stubGlobal("CompressionStream", undefined);
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    bodies.push(new Request(url, init).json() as Promise<AzureMonitorEnvelope[]>);
    return new Response(null);
  });
  vi.stubGlobal("fetch", fetch);
  const handle = await useMicrosoftOpenTelemetry({
    session: { enabled: false },
    userContext: { enabled: false },
    pageView: { enabled: false },
    ...options,
  });
  handles.push(handle);
  return { handle, fetch, envelopes: async () => (await Promise.all(bodies)).flat() };
}

it("returns before resolution and bounds traces and logs together before batching", async () => {
  installFakeClock();
  const pending = deferred();
  const customSpan = { onStart() {}, onEnd: vi.fn(), async forceFlush() {}, async shutdown() {} };
  const customLog = { onEmit: vi.fn(), async forceFlush() {}, async shutdown() {} };
  const result = await start({
    azureMonitor: { connectionString: pending.promise, initInMemoMaxSize: 2 },
    spanProcessors: [customSpan],
    logRecordProcessors: [customLog],
  });
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  trace.getTracer("startup").startSpan("retained span").end();
  logs.getLogger("startup").emit({ body: "retained log" });
  logs.getLogger("startup").emit({ body: "overflow" });
  expect(customSpan.onEnd).toHaveBeenCalledOnce();
  expect(customLog.onEmit).toHaveBeenCalledTimes(2);
  await result.handle.forceFlush();
  expect(result.fetch).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith("Telemetry startup queue full; dropping new items");
  pending.resolve(connectionString);
  await Promise.resolve();
  await result.handle.forceFlush();
  const envelopes = await result.envelopes();
  expect(envelopes).toHaveLength(2);
  expect(envelopes.map((item) => item.iKey)).toEqual(
    Array(2).fill("00000000-0000-0000-0000-000000000000"),
  );
  expect(envelopes[0].data.baseData).toMatchObject({ name: "retained span" });
  expect(envelopes[1].data.baseData).toMatchObject({ message: "retained log" });
  logs.getLogger("startup").emit({ body: "after resolution" });
  await result.handle.forceFlush();
  expect(await result.envelopes()).toHaveLength(3);
});

it.each(["timeout", "rejected", "invalid"] as const)(
  "disables Azure Monitor after %s and ignores late resolution",
  async (failure) => {
    const clock = installFakeClock();
    const pending = deferred();
    const result = await start({
      azureMonitor: { connectionString: pending.promise, initTimeOut: 10 },
    });
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
    logs.getLogger("failure").emit({ body: "buffered" });
    if (failure === "timeout") await clock.advance(10);
    else if (failure === "rejected") pending.reject();
    else pending.resolve("invalid");
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith(
      "Telemetry startup failed or timed out; dropping 1 buffered items",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private reason");
    pending.resolve(connectionString);
    await Promise.resolve();
    logs.getLogger("failure").emit({ body: "after failure" });
    await result.handle.forceFlush();
    expect(result.fetch).not.toHaveBeenCalled();
  },
);

it.each(["traces", "logs"] as const)(
  "keeps an explicitly disabled %s signal off",
  async (signal) => {
    const result = await start({
      azureMonitor: { connectionString: Promise.resolve(connectionString) },
      ...(signal === "traces" ? { spanProcessors: [] } : { logRecordProcessors: [] }),
    });
    trace.getTracer("disabled").startSpan("span").end();
    logs.getLogger("disabled").emit({ body: "log" });
    await result.handle.forceFlush();
    const envelopes = await result.envelopes();
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].data.baseType).toBe(
      signal === "traces" ? "MessageData" : "RemoteDependencyData",
    );
  },
);

it("cancels pending resolution on shutdown", async () => {
  installFakeClock();
  const pending = deferred();
  const result = await start({ azureMonitor: { connectionString: pending.promise } });
  logs.getLogger("stop").emit({ body: "pending" });
  await result.handle.shutdown();
  pending.resolve(connectionString);
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
  expect(result.fetch).not.toHaveBeenCalled();
});
