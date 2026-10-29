// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import { ErrorsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/errors";
import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";
import { NavigationInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation";
import { UserActionInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/user-action";
import { WebVitalsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/web-vitals";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { afterEach, expect, it, vi } from "vitest";
import {
  onCLS,
  onFCP,
  onINP,
  onLCP,
  onTTFB,
  type FCPMetricWithAttribution,
} from "web-vitals/attribution";
import {
  useMicrosoftOpenTelemetry,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { PageViewInstrumentation } from "../../../src/instrumentation/pageView/index.js";
import { startTelemetryInstance } from "../../../src/routing/telemetryInstance.js";

vi.mock("../../../src/routing/telemetryInstance.js", () => ({ startTelemetryInstance: vi.fn() }));
vi.mock("web-vitals/attribution", () => ({
  onCLS: vi.fn(),
  onFCP: vi.fn(),
  onINP: vi.fn(),
  onLCP: vi.fn(),
  onTTFB: vi.fn(),
}));

function fakeInstance() {
  return {
    tracerProvider: { getTracer: vi.fn() },
    loggerProvider: { getLogger: vi.fn(() => ({ emit: vi.fn(), enabled: () => true })) },
    commit: vi.fn(),
    abort: vi.fn(),
    detach: vi.fn(),
    shutdown: vi.fn(async () => {}),
  };
}

const handles = new Set<MicrosoftOpenTelemetryBrowser>();

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  vi.restoreAllMocks();
  vi.mocked(startTelemetryInstance).mockReset();
  for (const register of [onCLS, onFCP, onINP, onLCP, onTTFB]) vi.mocked(register).mockClear();
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

async function initialize(
  instrumentations: readonly BrowserInstrumentation[],
  options: Partial<MicrosoftOpenTelemetryBrowserOptions> = {},
) {
  const sdk = fakeInstance();
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(sdk);
  // Page view is owned by the distribution and on by default. These tests cover the registration
  // mechanics for caller-supplied instances, so it is switched off to keep the list exact.
  const handle = await useMicrosoftOpenTelemetry({
    instrumentations,
    pageView: { enabled: false },
    ...options,
  });
  handles.add(handle);
  return { handle, sdk };
}

it("binds the instance's own providers before enabling deferred instrumentation", async () => {
  const instrumentation = createInstrumentation();
  const { handle, sdk } = await initialize(Object.freeze([instrumentation]));
  expect(instrumentation.setTracerProvider).toHaveBeenCalledExactlyOnceWith(sdk.tracerProvider);
  expect(instrumentation.setLoggerProvider).toHaveBeenCalledExactlyOnceWith(sdk.loggerProvider);
  expect(startTelemetryInstance).toHaveBeenCalledBefore(instrumentation.setTracerProvider);
  expect(instrumentation.setTracerProvider).toHaveBeenCalledBefore(instrumentation.enable);
  expect(instrumentation.setLoggerProvider).toHaveBeenCalledBefore(instrumentation.enable);
  expect(instrumentation.enable).toHaveBeenCalledOnce();
  expect(instrumentation.getConfig()).toEqual({ enabled: false });
  await handle.shutdown();
  expect(instrumentation.disable).toHaveBeenCalledBefore(sdk.shutdown);
});

it("rebinds already-enabled instrumentation without enabling it twice", async () => {
  const instrumentation = createInstrumentation(true);
  await initialize([instrumentation]);
  expect(instrumentation.setTracerProvider).toHaveBeenCalledOnce();
  expect(instrumentation.setLoggerProvider).toHaveBeenCalledOnce();
  expect(instrumentation.enable).not.toHaveBeenCalled();
});

it("supports trace-only instrumentation and an unspecified enabled state", async () => {
  const instrumentation = createInstrumentation();
  const { setLoggerProvider: _setLoggerProvider, ...traceOnly } = instrumentation;
  traceOnly.getConfig.mockReturnValueOnce({});
  await initialize([traceOnly]);
  expect(traceOnly.setTracerProvider).toHaveBeenCalledOnce();
  expect(traceOnly.enable).toHaveBeenCalledOnce();
});

it("does not register instances omitted by the caller", async () => {
  const selected = createInstrumentation();
  const omitted = createInstrumentation();
  await initialize([selected]);
  expect(omitted.setTracerProvider).not.toHaveBeenCalled();
  expect(omitted.setLoggerProvider).not.toHaveBeenCalled();
  expect(omitted.enable).not.toHaveBeenCalled();
  expect(omitted.disable).not.toHaveBeenCalled();
});

it("uses inherited data names without invoking optional metadata accessors", async () => {
  const instrumentation = createInstrumentation();
  Object.setPrototypeOf(instrumentation, { instrumentationName: "custom-name" });
  const getter = vi.fn(() => "0.8.1");
  const accessor = createInstrumentation();
  Object.defineProperty(accessor, "instrumentationVersion", { get: getter });
  const { handle } = await initialize([instrumentation, accessor]);
  expect(handle.instrumentations.get("custom-name")).toBe(instrumentation);
  expect(handle.instrumentations.get("instrumentation")).toBe(accessor);
  expect(getter).not.toHaveBeenCalled();
});

it("does not require introspection of optional metadata for startup", async () => {
  const instrumentation = new Proxy(createInstrumentation(), {
    getOwnPropertyDescriptor() {
      throw new Error("metadata unavailable");
    },
  });
  const { handle } = await initialize([instrumentation]);
  expect(handle.instrumentations.get("instrumentation")).toBe(instrumentation);
});

it("owns shutdown even when no instrumentation is selected", async () => {
  const { handle, sdk } = await initialize([]);
  await handle.shutdown();
  await handle.shutdown();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
});

it("wraps the upstream handle to provide distro lifecycle when nothing is registered", async () => {
  const { handle, sdk } = await initialize([]);
  expect(handle).not.toBe(sdk);
  expect(handle.forceFlush).toBeTypeOf("function");
});

it("wraps the upstream handle for the instrumentation the distribution owns", async () => {
  const { handle, sdk } = await initialize([], { pageView: undefined });
  expect(handle).not.toBe(sdk);
});

it("registers runtime-supported optional upstream instrumentations by stable IDs", async () => {
  const console = new ConsoleInstrumentation({ enabled: false });
  const errors = new ErrorsInstrumentation({ enabled: false });
  const userAction = new UserActionInstrumentation({ enabled: false });
  const webVitals = new WebVitalsInstrumentation({ enabled: false });
  const { handle } = await initialize([console, errors, userAction, webVitals]);

  expect(handle.instrumentations.get("console")).toBe(console);
  expect(handle.instrumentations.get("errors")).toBe(errors);
  expect(handle.instrumentations.get("user-action")).toBe(userAction);
  expect(handle.instrumentations.get("web-vitals")).toBe(webVitals);

  const disable = vi.spyOn(webVitals, "disable");
  const enable = vi.spyOn(webVitals, "enable");
  await handle.instrumentations.setEnabled("web-vitals", false);
  await handle.instrumentations.setEnabled("web-vitals", true);
  expect(disable).toHaveBeenCalledOnce();
  expect(enable).toHaveBeenCalledOnce();
});

it("pauses Web Vitals emission and resumes the same object without registering callbacks again", async () => {
  const firstInstrumentation = new WebVitalsInstrumentation({ enabled: false });
  const secondInstrumentation = new WebVitalsInstrumentation({ enabled: false });
  const first = await initialize([firstInstrumentation]);
  const second = await initialize([secondInstrumentation]);
  const firstEmit = first.sdk.loggerProvider.getLogger.mock.results[0].value.emit;
  const secondEmit = second.sdk.loggerProvider.getLogger.mock.results[0].value.emit;
  const metric: FCPMetricWithAttribution = {
    name: "FCP",
    value: 100,
    delta: 100,
    rating: "good",
    id: "pause-resume-fcp",
    navigationId: 1,
    navigationType: "navigate",
    entries: [],
    attribution: { timeToFirstByte: 25, firstByteToFCP: 75, loadState: "complete" },
  };
  // Drive the callbacks registered by the real upstream instrumentation, not its private methods.
  const report = () => {
    for (const [callback] of vi.mocked(onFCP).mock.calls) callback(metric);
  };
  for (const register of [onCLS, onFCP, onINP, onLCP, onTTFB]) {
    expect(register).toHaveBeenCalledTimes(2);
  }

  report();
  expect(firstEmit).toHaveBeenCalledOnce();
  expect(secondEmit).toHaveBeenCalledOnce();
  expect(firstEmit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      eventName: "browser.web_vital",
      attributes: expect.objectContaining({
        "browser.web_vital.name": "fcp",
        "browser.web_vital.id": metric.id,
      }),
    }),
  );

  await first.handle.instrumentations.setEnabled("web-vitals", false);
  report();
  expect(firstEmit).toHaveBeenCalledOnce();
  expect(secondEmit).toHaveBeenCalledTimes(2);

  await first.handle.instrumentations.setEnabled("web-vitals", true);
  expect(first.handle.instrumentations.get("web-vitals")).toBe(firstInstrumentation);
  report();
  expect(firstEmit).toHaveBeenCalledTimes(2);
  expect(secondEmit).toHaveBeenCalledTimes(3);
  for (const register of [onCLS, onFCP, onINP, onLCP, onTTFB]) {
    expect(register).toHaveBeenCalledTimes(2);
  }
});

it("rejects one Web Vitals object registered twice before it can enable twice", async () => {
  const webVitals = new WebVitalsInstrumentation({ enabled: false });
  const enable = vi.spyOn(webVitals, "enable");
  await expect(initialize([webVitals, webVitals])).rejects.toThrow("browser-instrumentation-owned");
  expect(enable).not.toHaveBeenCalled();
});

it.each([
  ["instrumentation", createInstrumentation()],
  ["navigation", new NavigationInstrumentation({ enabled: false })],
  ["@microsoft/opentelemetry-browser/page-view", new PageViewInstrumentation({ enabled: false })],
] as const)(
  "rejects runtime lifecycle for unsupported %s instrumentation",
  async (id, instrumentation) => {
    const { handle } = await initialize([instrumentation]);
    await expect(handle.instrumentations.setEnabled(id, false)).rejects.toThrow(
      `Runtime lifecycle is unsupported for instrumentation: ${id}`,
    );
  },
);

it("snapshots the supplied list and cleans up once in reverse registration order", async () => {
  const first = createInstrumentation();
  const second = createInstrumentation();
  const list = [first, second];
  const { handle, sdk } = await initialize(list);
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

it("keeps the initial list when the caller mutates it during asynchronous resource startup", async () => {
  let resolve!: (name: string) => void;
  const resource = resourceFromAttributes({
    "service.name": new Promise<string>((done) => {
      resolve = done;
    }),
  });
  const first = createInstrumentation();
  const second = createInstrumentation();
  const replacement = createInstrumentation();
  const list = [first, second];
  const pending = initialize(list, { resource });
  list.splice(0, list.length, replacement);
  expect(first.setTracerProvider).not.toHaveBeenCalled();
  resolve("registry-snapshot-test");
  const { handle } = await pending;

  expect(first.setTracerProvider).toHaveBeenCalledOnce();
  expect(second.enable).toHaveBeenCalledOnce();
  expect(replacement.setTracerProvider).not.toHaveBeenCalled();
  expect(replacement.enable).not.toHaveBeenCalled();
  await handle.shutdown();
  expect(second.disable).toHaveBeenCalledBefore(first.disable);
  expect(replacement.disable).not.toHaveBeenCalled();
});

it("releases every claim if unload subscription fails before provider binding", async () => {
  const first = createInstrumentation();
  const last = createInstrumentation();
  const failure = new Error("unload subscription failed");
  const addEventListener = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((...args) => {
    if (args[0] === "visibilitychange") throw failure;
    addEventListener(...args);
  });
  const sdk = fakeInstance();
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(sdk);
  await expect(
    useMicrosoftOpenTelemetry({
      instrumentations: [first, last],
      pageView: { enabled: false },
      session: { enabled: false },
      userContext: { enabled: false },
    }),
  ).rejects.toBe(failure);
  expect(first.setTracerProvider).not.toHaveBeenCalled();
  expect(last.setLoggerProvider).not.toHaveBeenCalled();
  expect(first.enable).not.toHaveBeenCalled();
  expect(last.disable).toHaveBeenCalledBefore(first.disable);
  expect(first.disable).toHaveBeenCalledBefore(sdk.abort);
  expect(sdk.shutdown).toHaveBeenCalledOnce();

  vi.restoreAllMocks();
  const { handle } = await initialize([first, last]);
  await handle.shutdown();
  expect(first.disable).toHaveBeenCalledTimes(2);
  expect(last.disable).toHaveBeenCalledTimes(2);
});

it("does not rebind or disable another instance's instrumentation after a claim conflict", async () => {
  const instrumentation = createInstrumentation();
  const first = await initialize([instrumentation]);
  const rejected = fakeInstance();
  vi.mocked(startTelemetryInstance).mockResolvedValueOnce(rejected);
  await expect(
    useMicrosoftOpenTelemetry({
      instrumentations: [instrumentation],
      pageView: { enabled: false },
      session: { enabled: false },
      userContext: { enabled: false },
    }),
  ).rejects.toThrow("browser-instrumentation-owned");
  expect(instrumentation.setTracerProvider).toHaveBeenCalledExactlyOnceWith(
    first.sdk.tracerProvider,
  );
  expect(instrumentation.setLoggerProvider).toHaveBeenCalledExactlyOnceWith(
    first.sdk.loggerProvider,
  );
  expect(instrumentation.disable).not.toHaveBeenCalled();
  expect(rejected.abort).toHaveBeenCalledOnce();
  expect(rejected.shutdown).toHaveBeenCalledOnce();
  await first.handle.shutdown();
  expect(instrumentation.disable).toHaveBeenCalledOnce();
});

it("continues cleanup and preserves a single instrumentation failure", async () => {
  const first = createInstrumentation();
  const second = createInstrumentation();
  const failure = new Error("disable failed");
  second.disable.mockImplementation(() => {
    throw failure;
  });
  const { handle, sdk } = await initialize([first, second]);
  handles.delete(handle);
  await expect(handle.shutdown()).rejects.toBe(failure);
  await expect(handle.shutdown()).rejects.toBe(failure);
  expect(first.disable).toHaveBeenCalledOnce();
  expect(second.disable).toHaveBeenCalledOnce();
  expect(sdk.shutdown).toHaveBeenCalledOnce();
});

it("retains and explicitly removes errors handlers after a partial upstream removal failure", async () => {
  const errors = new ErrorsInstrumentation({ enabled: false });
  const { handle } = await initialize([errors]);
  const handler = (errors as unknown as { _onErrorHandler?: EventListener })._onErrorHandler;
  expect(handler).toBeTypeOf("function");
  const remove = vi.spyOn(window, "removeEventListener");
  remove.mockImplementationOnce(() => {
    throw new Error("partial errors removal failed");
  });

  await expect(handle.instrumentations.setEnabled("errors", false)).rejects.toThrow(
    "partial errors removal failed",
  );
  expect(remove).toHaveBeenCalledWith("unhandledrejection", handler);
  await expect(handle.instrumentations.setEnabled("errors", true)).rejects.toThrow(
    "Instrumentation rollback failed; shutdown is required.",
  );

  await handle.shutdown();
  expect(remove).toHaveBeenCalledWith("error", handler);
  expect(remove).toHaveBeenCalledWith("unhandledrejection", handler);
});

it("does not re-enable errors when shutdown reenters through listener registration", async () => {
  const errors = new ErrorsInstrumentation({ enabled: false });
  const { handle } = await initialize([errors]);
  await handle.instrumentations.setEnabled("errors", false);
  const enable = vi.spyOn(errors, "enable");
  let shutdown: Promise<void> | undefined;
  const nativeAdd = window.addEventListener.bind(window);
  const nativeRemove = window.removeEventListener.bind(window);
  const removed: { name: string; listener: EventListenerOrEventListenerObject | null }[] = [];
  vi.spyOn(window, "removeEventListener").mockImplementation((...args) => {
    nativeRemove(...args);
    removed.push({ name: args[0], listener: args[1] });
  });
  const add = vi.spyOn(window, "addEventListener").mockImplementation((...args) => {
    if (args[0] === "error") shutdown ??= handle.shutdown();
    nativeAdd(...args);
  });

  await expect(handle.instrumentations.setEnabled("errors", true)).rejects.toThrow(
    "Telemetry instance is stopped.",
  );
  await shutdown;
  expect(add).toHaveBeenCalledWith("error", expect.any(Function));
  for (const [name, listener] of add.mock.calls) {
    // Reentrant disable clears upstream's handler before its second add; undefined is a no-op.
    if (listener && (name === "error" || name === "unhandledrejection")) {
      expect(removed).toContainEqual({ name, listener });
    }
  }
  expect(enable).toHaveBeenCalledOnce();
  await expect(handle.instrumentations.setEnabled("errors", true)).rejects.toThrow(
    "Telemetry instance is stopped.",
  );
});

it("rolls back successful peers in reverse order and blocks queued operations after a lifecycle failure", async () => {
  const first = new FetchInstrumentation({ enabled: false });
  const failing = new FetchInstrumentation({ enabled: false });
  const last = new FetchInstrumentation({ enabled: false });
  const { handle } = await initialize([first, failing, last], {
    spanProcessors: [{} as never],
  });
  const firstDisable = vi.spyOn(first, "disable");
  const firstEnable = vi.spyOn(first, "enable");
  const failingEnable = vi.spyOn(failing, "enable");
  const lastDisable = vi.spyOn(last, "disable");
  const failure = new Error("fetch removal failed");
  const failingDisable = vi.spyOn(failing, "disable").mockImplementationOnce(() => {
    throw failure;
  });

  const rejected = handle.updateCfg({ disableFetchTracking: true });
  const queued = handle.updateCfg({ samplingPercentage: 50 });
  await expect(rejected).rejects.toThrow(failure);
  await expect(queued).rejects.toThrow("Instrumentation rollback failed; shutdown is required.");
  expect(firstDisable).toHaveBeenCalledOnce();
  expect(firstEnable).toHaveBeenCalledOnce();
  expect(firstDisable).toHaveBeenCalledBefore(firstEnable);
  expect(failingEnable).toHaveBeenCalledOnce();
  expect(failingDisable).toHaveBeenCalledBefore(failingEnable);
  expect(failingEnable).toHaveBeenCalledBefore(firstEnable);
  expect(lastDisable).not.toHaveBeenCalled();
  expect(failingDisable).toHaveBeenCalledOnce();
  await expect(handle.instrumentations.setEnabled("fetch", false)).rejects.toThrow(
    "Instrumentation rollback failed; shutdown is required.",
  );
});

it("preserves lifecycle and rollback failures while attempting every inverse in reverse order", async () => {
  const first = new FetchInstrumentation({ enabled: false });
  const failing = new FetchInstrumentation({ enabled: false });
  const { handle } = await initialize([first, failing], { spanProcessors: [{} as never] });
  const failure = new Error("fetch removal failed");
  const rollbackFailure = new Error("fetch rollback failed");
  const firstEnable = vi.spyOn(first, "enable");
  const failingEnable = vi.spyOn(failing, "enable").mockImplementationOnce(() => {
    throw rollbackFailure;
  });
  vi.spyOn(failing, "disable").mockImplementationOnce(() => {
    throw failure;
  });

  await expect(handle.updateCfg({ disableFetchTracking: true })).rejects.toMatchObject({
    name: "AggregateError",
    cause: failure,
    errors: [failure, rollbackFailure],
  });
  expect(failingEnable).toHaveBeenCalledBefore(firstEnable);
  expect(firstEnable).toHaveBeenCalledOnce();
  await expect(handle.updateCfg({ samplingPercentage: 50 })).rejects.toThrow(
    "Instrumentation rollback failed; shutdown is required.",
  );
});

it("rejects runtime changes after shutdown without reviving an instrumentation", async () => {
  const console = new ConsoleInstrumentation({ enabled: false });
  const { handle } = await initialize([console]);
  await handle.shutdown();
  const enable = vi.spyOn(console, "enable");

  await expect(handle.updateCfg({ samplingPercentage: 50 })).rejects.toThrow(
    "Telemetry instance is stopped.",
  );
  await expect(handle.instrumentations.setEnabled("console", true)).rejects.toThrow(
    "Telemetry instance is stopped.",
  );
  expect(enable).not.toHaveBeenCalled();
});

it("reports all instrumentation and SDK shutdown failures", async () => {
  const instrumentation = createInstrumentation();
  const disableFailure = new Error("disable failed");
  const sdkFailure = new Error("SDK shutdown failed");
  instrumentation.disable.mockImplementation(() => {
    throw disableFailure;
  });
  const { handle, sdk } = await initialize([instrumentation]);
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
  const { handle, sdk } = await initialize([instrumentation]);
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
    const sdk = fakeInstance();
    vi.mocked(startTelemetryInstance).mockResolvedValueOnce(sdk);
    await expect(
      useMicrosoftOpenTelemetry({ instrumentations: [first, failing, last] }),
    ).rejects.toThrow(failure);
    expect(last.disable).toHaveBeenCalledBefore(failing.disable);
    expect(failing.disable).toHaveBeenCalledBefore(first.disable);
    expect(first.disable).toHaveBeenCalledBefore(sdk.shutdown);
    expect(last.setTracerProvider).not.toHaveBeenCalled();
    await sdk.shutdown.mock.results[0].value;
  },
);

it.each([false, true])(
  "preserves initialization errors when cleanup fails and diagnostics throw=%s",
  async (diagnosticsThrow) => {
    const instrumentation = createInstrumentation();
    const failure = new Error("registration failed");
    const cleanupFailure = new Error("SDK shutdown failed");
    instrumentation.enable.mockImplementation(() => {
      throw failure;
    });
    const report = vi.spyOn(diag, "error").mockImplementation(() => {
      if (diagnosticsThrow) throw new Error("diagnostic logger failed");
    });
    vi.mocked(startTelemetryInstance).mockResolvedValueOnce({
      ...fakeInstance(),
      shutdown: vi.fn().mockRejectedValue(cleanupFailure),
    });
    await expect(useMicrosoftOpenTelemetry({ instrumentations: [instrumentation] })).rejects.toBe(
      failure,
    );
    expect(report).toHaveBeenCalledExactlyOnceWith(
      "Telemetry initialization cleanup failed",
      cleanupFailure,
    );
  },
);
