// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LoggerProvider, TextMapPropagator, TracerProvider } from "@opentelemetry/api";
import type { BrowserInstrumentation, BrowserNativeInstrumentation } from "../../types.js";

type NativeState = "new" | "enabled" | "disabled" | "failed";
type NativeDeps = {
  tracerProvider?: TracerProvider;
  loggerProvider?: LoggerProvider;
  propagator?: TextMapPropagator;
};

const nativeInstrumentations =
  /^@opentelemetry\/browser-instrumentation\/(fetch|xhr|console|errors|user-action|web-vitals|navigation|navigation-timing|resource-timing)$/;

function value(object: object, key: PropertyKey): unknown {
  try {
    let target: object | null = object;
    while (target) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor) return descriptor.value as unknown;
      target = Object.getPrototypeOf(target) as object | null;
    }
  } catch {
    // Optional native metadata must not prevent registration of opaque classic instances.
  }
  return undefined;
}

function state(instrumentation: object): NativeState | undefined {
  const current = value(instrumentation, "_state");
  return current === "new" ||
    current === "enabled" ||
    current === "disabled" ||
    current === "failed"
    ? current
    : undefined;
}

export function isAdaptedNativeInstrumentation(instrumentation: object): boolean {
  return value(instrumentation, "__microsoftBrowserNativeInstrumentation") === true;
}

/** Reads pinned native state so a locked instance cannot be registered on a different handle. */
export function nativeInstrumentationState(instrumentation: object): NativeState | undefined {
  return isAdaptedNativeInstrumentation(instrumentation) ? state(instrumentation) : undefined;
}

/** Adds the classic distro lifecycle surface to one pinned native object without changing identity. */
export function adaptNativeInstrumentation(
  instrumentation: BrowserInstrumentation | BrowserNativeInstrumentation,
): BrowserInstrumentation {
  if (isAdaptedNativeInstrumentation(instrumentation))
    return instrumentation as BrowserInstrumentation;
  const name = value(instrumentation, "instrumentationName");
  const nativeShape =
    typeof name === "string" &&
    nativeInstrumentations.test(name) &&
    typeof value(instrumentation, "enable") === "function" &&
    typeof value(instrumentation, "disable") === "function" &&
    typeof value(instrumentation, "isEnabled") === "function" &&
    typeof value(instrumentation, "setTracerProvider") !== "function" &&
    typeof value(instrumentation, "getConfig") !== "function";
  if (nativeShape && value(instrumentation, "instrumentationVersion") !== "0.12.1") {
    throw new Error("Unsupported native browser instrumentation version.");
  }
  if (!nativeShape || value(instrumentation, "instrumentationVersion") !== "0.12.1") {
    return instrumentation as BrowserInstrumentation;
  }

  if (state(instrumentation) !== "new") {
    throw new Error("Construct native browser instrumentations without enabling them first.");
  }
  const config = value(instrumentation, "_config");
  if (!config || typeof config !== "object") {
    throw new TypeError("Native browser instrumentation config is unavailable.");
  }

  const enable = value(instrumentation, "enable") as (deps?: NativeDeps) => void;
  const disable = value(instrumentation, "disable") as () => void;
  let tracerProvider: TracerProvider | undefined;
  let loggerProvider: LoggerProvider | undefined;
  let initialized = false;

  Object.assign(instrumentation, {
    setTracerProvider(provider: TracerProvider): void {
      if (initialized) throw new Error("Native instrumentation providers are already initialized.");
      tracerProvider = provider;
    },
    setLoggerProvider(provider: LoggerProvider): void {
      if (initialized) throw new Error("Native instrumentation providers are already initialized.");
      loggerProvider = provider;
    },
    getConfig(): { enabled: false } & Record<string, unknown> {
      return { ...(config as Record<string, unknown>), enabled: false };
    },
    setConfig(next: Record<string, unknown>): void {
      if (initialized) throw new Error("Native instrumentation config is already initialized.");
      for (const key of Reflect.ownKeys(config)) Reflect.deleteProperty(config, key);
      Object.assign(config, next, { enabled: false });
    },
    enable(): void {
      initialized = true;
      const deps: NativeDeps = {};
      if (tracerProvider) deps.tracerProvider = tracerProvider;
      if (loggerProvider) deps.loggerProvider = loggerProvider;
      enable.call(instrumentation, deps);
      if (state(instrumentation) !== "enabled") {
        throw new Error("Native browser instrumentation failed to initialize.");
      }
    },
    disable(): void {
      disable.call(instrumentation);
      if (state(instrumentation) === "failed") {
        throw new Error("Native browser instrumentation failed to disable.");
      }
    },
  });

  Object.defineProperty(instrumentation, "__microsoftBrowserNativeInstrumentation", {
    value: true,
  });
  return instrumentation as BrowserInstrumentation;
}
