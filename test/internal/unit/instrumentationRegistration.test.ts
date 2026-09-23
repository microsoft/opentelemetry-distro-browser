// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { afterEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
} from "../../../src/index.js";

vi.mock("@opentelemetry/browser-sdk", () => ({ startBrowserSdk: vi.fn() }));

const handles = new Set<MicrosoftOpenTelemetryBrowser>();

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  vi.restoreAllMocks();
  vi.mocked(startBrowserSdk).mockReset();
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

function createInstrumentation(enabled: boolean | undefined = false) {
  const config = Object.freeze({ enabled });
  return {
    setTracerProvider: vi.fn<BrowserInstrumentation["setTracerProvider"]>(),
    setLoggerProvider: vi.fn<NonNullable<BrowserInstrumentation["setLoggerProvider"]>>(),
    getConfig: vi.fn<BrowserInstrumentation["getConfig"]>(() => config),
    enable: vi.fn(),
    disable: vi.fn(),
  };
}

function initialize(instrumentations: readonly BrowserInstrumentation[]) {
  const sdk = { shutdown: vi.fn(async () => {}) };
  vi.mocked(startBrowserSdk).mockReturnValueOnce(sdk);
  const handle = useMicrosoftOpenTelemetry({ instrumentations });
  handles.add(handle);
  return { handle, sdk };
}

it("binds providers after SDK startup and before enabling deferred instrumentation", async () => {
  const instrumentation = createInstrumentation();
  const { handle, sdk } = initialize(Object.freeze([instrumentation]));
  expect(instrumentation.setTracerProvider).toHaveBeenCalledExactlyOnceWith(
    trace.getTracerProvider(),
  );
  expect(instrumentation.setLoggerProvider).toHaveBeenCalledExactlyOnceWith(
    logs.getLoggerProvider(),
  );
  expect(startBrowserSdk).toHaveBeenCalledBefore(instrumentation.setTracerProvider);
  expect(instrumentation.setTracerProvider).toHaveBeenCalledBefore(instrumentation.enable);
  expect(instrumentation.setLoggerProvider).toHaveBeenCalledBefore(instrumentation.enable);
  expect(instrumentation.enable).toHaveBeenCalledOnce();
  expect(instrumentation.getConfig()).toEqual({ enabled: false });
  await handle.shutdown();
  expect(instrumentation.disable).toHaveBeenCalledBefore(sdk.shutdown);
});

it("rebinds already-enabled instrumentation without enabling it twice", () => {
  const instrumentation = createInstrumentation(true);
  initialize([instrumentation]);
  expect(instrumentation.setTracerProvider).toHaveBeenCalledOnce();
  expect(instrumentation.setLoggerProvider).toHaveBeenCalledOnce();
  expect(instrumentation.enable).not.toHaveBeenCalled();
});

it("supports trace-only instrumentation and an unspecified enabled state", () => {
  const instrumentation = createInstrumentation();
  const { setLoggerProvider: _setLoggerProvider, ...traceOnly } = instrumentation;
  traceOnly.getConfig.mockReturnValueOnce({});
  initialize([traceOnly]);
  expect(traceOnly.setTracerProvider).toHaveBeenCalledOnce();
  expect(traceOnly.enable).toHaveBeenCalledOnce();
});

it("does not register instances omitted by the caller", () => {
  const selected = createInstrumentation();
  const omitted = createInstrumentation();
  initialize([selected]);
  expect(omitted.setTracerProvider).not.toHaveBeenCalled();
  expect(omitted.setLoggerProvider).not.toHaveBeenCalled();
  expect(omitted.enable).not.toHaveBeenCalled();
  expect(omitted.disable).not.toHaveBeenCalled();
});

it("retains the upstream handle when no instrumentation is selected", () => {
  const { handle, sdk } = initialize([]);
  expect(handle).toBe(sdk);
});

it("snapshots the supplied list and cleans up once in reverse registration order", async () => {
  const first = createInstrumentation();
  const second = createInstrumentation();
  const list = [first, second];
  const { handle, sdk } = initialize(list);
  list.length = 0;
  const shutdown = handle.shutdown();
  expect(handle.shutdown()).toBe(shutdown);
  await shutdown;
  await handle.shutdown();
  expect(second.disable).toHaveBeenCalledBefore(first.disable);
  expect(first.disable).toHaveBeenCalledBefore(sdk.shutdown);
  expect(first.disable).toHaveBeenCalledOnce();
  expect(second.disable).toHaveBeenCalledOnce();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
});

it("continues cleanup and preserves a single instrumentation failure", async () => {
  const first = createInstrumentation();
  const second = createInstrumentation();
  const failure = new Error("disable failed");
  second.disable.mockImplementation(() => {
    throw failure;
  });
  const { handle, sdk } = initialize([first, second]);
  handles.delete(handle);
  await expect(handle.shutdown()).rejects.toBe(failure);
  await expect(handle.shutdown()).rejects.toBe(failure);
  expect(first.disable).toHaveBeenCalledOnce();
  expect(second.disable).toHaveBeenCalledOnce();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
});

it("reports all instrumentation and SDK shutdown failures", async () => {
  const instrumentation = createInstrumentation();
  const disableFailure = new Error("disable failed");
  const sdkFailure = new Error("SDK shutdown failed");
  instrumentation.disable.mockImplementation(() => {
    throw disableFailure;
  });
  const { handle, sdk } = initialize([instrumentation]);
  sdk.shutdown.mockRejectedValueOnce(sdkFailure);
  handles.delete(handle);
  await expect(handle.shutdown()).rejects.toMatchObject({
    name: "AggregateError",
    errors: [disableFailure, sdkFailure],
  });
});

it("propagates an SDK shutdown failure after disabling instrumentation", async () => {
  const instrumentation = createInstrumentation();
  const failure = new Error("SDK shutdown failed");
  const { handle, sdk } = initialize([instrumentation]);
  sdk.shutdown.mockRejectedValueOnce(failure);
  handles.delete(handle);
  await expect(handle.shutdown()).rejects.toBe(failure);
  expect(instrumentation.disable).toHaveBeenCalledBefore(sdk.shutdown);
});

it.each(["setTracerProvider", "setLoggerProvider", "getConfig", "enable"] as const)(
  "rolls back all supplied instances and the SDK if %s fails",
  async (method) => {
    const first = createInstrumentation();
    const failing = createInstrumentation();
    const last = createInstrumentation(true);
    const failure = new Error("registration failed");
    failing[method].mockImplementation(() => {
      throw failure;
    });
    const sdk = { shutdown: vi.fn(async () => {}) };
    vi.mocked(startBrowserSdk).mockReturnValueOnce(sdk);
    expect(() => useMicrosoftOpenTelemetry({ instrumentations: [first, failing, last] })).toThrow(
      failure,
    );
    expect(last.disable).toHaveBeenCalledBefore(failing.disable);
    expect(failing.disable).toHaveBeenCalledBefore(first.disable);
    expect(first.disable).toHaveBeenCalledBefore(sdk.shutdown);
    expect(last.setTracerProvider).not.toHaveBeenCalled();
    await sdk.shutdown.mock.results[0].value;
  },
);

it("reports asynchronous rollback failures without replacing the initialization error", async () => {
  const instrumentation = createInstrumentation();
  const failure = new Error("registration failed");
  const cleanupFailure = new Error("SDK shutdown failed");
  instrumentation.enable.mockImplementation(() => {
    throw failure;
  });
  const report = vi.spyOn(diag, "error").mockImplementation(() => {});
  vi.mocked(startBrowserSdk).mockReturnValueOnce({
    shutdown: vi.fn().mockRejectedValue(cleanupFailure),
  });
  expect(() => useMicrosoftOpenTelemetry({ instrumentations: [instrumentation] })).toThrow(failure);
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledExactlyOnceWith(
      "Instrumentation initialization cleanup failed",
      cleanupFailure,
    ),
  );
});
