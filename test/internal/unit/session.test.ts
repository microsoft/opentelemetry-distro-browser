// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { LocalStorageSessionStore } from "@opentelemetry/browser-sdk/session";
import type { Session } from "@opentelemetry/browser-sdk/session";
import type { ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
} from "../../../src/index.js";

vi.mock("@opentelemetry/browser-sdk", { spy: true });

const storageKey = "opentelemetry-session";
const handles = new Set<MicrosoftOpenTelemetryBrowser>();
let previousSession: string | null;

function resetApis() {
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
}

beforeEach(() => {
  previousSession = localStorage.getItem(storageKey);
  localStorage.removeItem(storageKey);
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  vi.mocked(startBrowserSdk).mockClear();
});

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  const timerCount = vi.getTimerCount();
  vi.useRealTimers();
  resetApis();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (previousSession === null) localStorage.removeItem(storageKey);
  else localStorage.setItem(storageKey, previousSession);
  expect(timerCount).toBe(0);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

async function initialize() {
  const spans: Span[] = [];
  const records: ReadWriteLogRecord[] = [];
  const handle = await useMicrosoftOpenTelemetry({
    pageView: { enabled: false },
    spanProcessors: [
      {
        onStart: (span) => {
          spans.push(span);
        },
        onEnd() {},
        async forceFlush() {},
        async shutdown() {},
      },
    ],
    logRecordProcessors: [
      {
        onEmit: (record) => {
          records.push(record);
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  });
  handles.add(handle);
  function emit() {
    trace.getTracer("session-test").startSpan("operation").end();
    logs.getLogger("session-test").emit({ eventName: "occurrence" });
    const spanId = spans.at(-1)?.attributes["session.id"];
    expect(records.at(-1)?.attributes["session.id"]).toBe(spanId);
    return spanId;
  }
  return { handle, emit, spans, records };
}

it("automatically generates and persists the same session ID before user processors run", async () => {
  const { emit } = await initialize();
  const id = emit();
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    id,
    startTimestamp: Date.now(),
  });
  expect(emit()).toBe(id);
});

it("awaits persisted restoration before starting providers or enabling instrumentation", async () => {
  const restored = { id: "restored-session", startTimestamp: Date.now() - 1000 };
  let restore!: (session: Session) => void;
  vi.spyOn(LocalStorageSessionStore.prototype, "get").mockReturnValueOnce(
    new Promise<Session>((resolve) => {
      restore = resolve;
    }),
  );
  const enable = vi.fn(() => {
    trace.getTracer("instrumentation").startSpan("first").end();
    logs.getLogger("instrumentation").emit({ eventName: "first" });
  });
  const spanIds: unknown[] = [];
  const logIds: unknown[] = [];
  const pending = useMicrosoftOpenTelemetry({
    pageView: { enabled: false },
    spanProcessors: [
      {
        onStart: (span) => {
          spanIds.push(span.attributes["session.id"]);
        },
        onEnd() {},
        async forceFlush() {},
        async shutdown() {},
      },
    ],
    logRecordProcessors: [
      {
        onEmit: (record) => {
          logIds.push(record.attributes["session.id"]);
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
    instrumentations: [
      {
        setTracerProvider() {},
        getConfig: () => ({ enabled: false }),
        enable,
        disable() {},
      },
    ],
  });
  expect(startBrowserSdk).not.toHaveBeenCalled();
  expect(enable).not.toHaveBeenCalled();
  restore(restored);
  handles.add(await pending);
  expect(spanIds).toEqual([restored.id]);
  expect(logIds).toEqual([restored.id]);
});

it("restores the persisted session across initialization and restarts inactivity countdown", async () => {
  const first = await initialize();
  const id = first.emit();
  await first.handle.shutdown();
  resetApis();
  await vi.advanceTimersByTimeAsync(2 * 1800_000);
  const second = await initialize();
  expect(second.emit()).toBe(id);
  await vi.advanceTimersByTimeAsync(1800_000);
  expect(second.emit()).not.toBe(id);
});

it.each([
  {},
  [],
  false,
  42,
  "session",
  { id: 42, startTimestamp: "bad" },
  { id: "", startTimestamp: 1000 },
  { id: "invalid", startTimestamp: -1 },
  { id: "invalid", startTimestamp: null },
])("replaces an invalid persisted session (%j) before emitting telemetry", async (stored) => {
  localStorage.setItem(storageKey, JSON.stringify(stored));
  const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
  const { emit } = await initialize();
  const id = emit();
  expect(id).toMatch(/^[0-9a-f]{32}$/);
  expect(JSON.parse(localStorage.getItem(storageKey)!)).toEqual({
    id,
    startTimestamp: Date.now(),
  });
  expect(warn).toHaveBeenCalledExactlyOnceWith("Invalid stored session; creating a new session.");
});

it("renews after the default 1800 seconds of inactivity without a telemetry-triggered timer", async () => {
  const { emit } = await initialize();
  const first = emit();
  await vi.advanceTimersByTimeAsync(1799_999);
  expect(JSON.parse(localStorage.getItem(storageKey)!).id).toBe(first);
  await vi.advanceTimersByTimeAsync(1);
  const renewed = JSON.parse(localStorage.getItem(storageKey)!).id;
  expect(renewed).not.toBe(first);
  expect(emit()).toBe(renewed);
});

it.each(["span", "log"])(
  "a %s refreshes upstream inactivity after its five-second debounce",
  async (signal) => {
    const { emit } = await initialize();
    const first = emit();
    await vi.advanceTimersByTimeAsync(6000);
    if (signal === "span") trace.getTracer("session-test").startSpan("activity").end();
    else logs.getLogger("session-test").emit({ eventName: "activity" });
    await vi.advanceTimersByTimeAsync(1799_999);
    expect(JSON.parse(localStorage.getItem(storageKey)!).id).toBe(first);
    await vi.advanceTimersByTimeAsync(1);
    expect(emit()).not.toBe(first);
  },
);

it("preserves a span's start ID when the session renews after inactivity", async () => {
  const { emit, spans } = await initialize();
  const id = emit();
  const span = trace.getTracer("session-test").startSpan("long");
  await vi.advanceTimersByTimeAsync(1800_000);
  expect(emit()).not.toBe(id);
  span.end();
  expect(spans[1].attributes["session.id"]).toBe(id);
});

it("keeps an active session beyond 24 hours without a maximum lifetime", async () => {
  const { emit } = await initialize();
  const id = emit();
  for (let interval = 0; interval < 75; interval++) {
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(emit()).toBe(id);
  }
});

it.each(["getter", "read", "write", "missing"])(
  "warns once and retains an in-memory session when storage is unavailable (%s)",
  async (failure) => {
    const warn = vi.spyOn(diag, "warn").mockImplementation(() => {});
    if (failure === "missing") vi.stubGlobal("localStorage", undefined);
    else if (failure === "getter") {
      vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
        throw new DOMException("denied", "SecurityError");
      });
    } else {
      vi.spyOn(Storage.prototype, failure === "read" ? "getItem" : "setItem").mockImplementation(
        () => {
          throw new DOMException(
            "denied",
            failure === "read" ? "SecurityError" : "QuotaExceededError",
          );
        },
      );
    }
    const { emit } = await initialize();
    const id = emit();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(emit()).toBe(id);
    await vi.advanceTimersByTimeAsync(1800_000);
    expect(emit()).not.toBe(id);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Session storage unavailable; using an in-memory session.",
    );
  },
);

it("does not mask unexpected storage errors or start providers on restoration failure", async () => {
  const failure = new Error("unexpected storage failure");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw failure;
  });
  await expect(useMicrosoftOpenTelemetry()).rejects.toBe(failure);
  expect(startBrowserSdk).not.toHaveBeenCalled();
});

it("stops session timers on SDK startup failure", async () => {
  const failure = new Error("SDK startup failed");
  vi.mocked(startBrowserSdk).mockImplementationOnce(() => {
    throw failure;
  });
  await expect(useMicrosoftOpenTelemetry()).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops session timers even when instrumentation and SDK shutdown fail", async () => {
  const sdkFailure = new Error("SDK shutdown failed");
  const instrumentationFailure = new Error("disable failed");
  vi.mocked(startBrowserSdk).mockReturnValueOnce({
    shutdown: vi.fn().mockRejectedValue(sdkFailure),
  });
  const handle = await useMicrosoftOpenTelemetry({
    pageView: { enabled: false },
    instrumentations: [
      {
        setTracerProvider() {},
        getConfig: () => ({ enabled: true }),
        enable() {},
        disable() {
          throw instrumentationFailure;
        },
      },
    ],
  });
  const shutdown = handle.shutdown();
  expect(handle.shutdown()).toBe(shutdown);
  await expect(shutdown).rejects.toMatchObject({
    errors: [instrumentationFailure, sdkFailure],
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans up session timers when instrumentation initialization rolls back", async () => {
  const failure = new Error("enable failed");
  await expect(
    useMicrosoftOpenTelemetry({
      spanProcessors: [],
      logRecordProcessors: [],
      instrumentations: [
        {
          setTracerProvider() {},
          getConfig: () => ({ enabled: false }),
          enable() {
            throw failure;
          },
          disable() {},
        },
      ],
    }),
  ).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
});

it("stale tracer and logger handles do not restart session timers after shutdown", async () => {
  const { handle } = await initialize();
  const tracer = trace.getTracer("stale");
  const logger = logs.getLogger("stale");
  await handle.shutdown();
  await vi.advanceTimersByTimeAsync(6000);
  tracer.startSpan("after-shutdown").end();
  logger.emit({ eventName: "after-shutdown" });
  expect(vi.getTimerCount()).toBe(0);
});
