// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TelemetryInstance } from "../routing/telemetryInstance.js";
import type { BrowserInstrumentation } from "../types.js";
import { claimInstrumentations, isNetworkInstrumentation } from "./sharedBrowserPatches.js";
import { throwErrors } from "../shared/lifecycle.js";

interface Entry {
  instrumentation: BrowserInstrumentation;
  kind: string | undefined;
  requested: boolean;
  active: boolean;
  errorHandlers?: Set<EventListener>;
  transitioning?: boolean;
}

type Gates = { readonly disableFetchTracking: boolean; readonly disableAjaxTracking: boolean };

/** Optional metadata must not invoke application accessors or prevent startup. */
function metadata(instrumentation: BrowserInstrumentation, key: string): unknown {
  try {
    let target: object | null = instrumentation;
    while (target) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      if (descriptor) return descriptor.value as unknown;
      target = Object.getPrototypeOf(target) as object | null;
    }
  } catch {
    /* Treat unavailable metadata as unnamed. */
  }
  return undefined;
}

/** Owns the initial instrumentation snapshot for one instance, without changing shared patches. */
export function createInstrumentationRegistry(
  instrumentations: readonly BrowserInstrumentation[],
  providers: Pick<TelemetryInstance, "tracerProvider" | "loggerProvider">,
  tracesEnabled: boolean,
  isStopped: () => boolean = () => false,
) {
  // Claim the whole list before any application callback can bind or enable an entry.
  const release = claimInstrumentations(instrumentations);
  const entries = new Map<string, Entry>();
  let gates: Gates = { disableFetchTracking: false, disableAjaxTracking: false };
  let failed = false;

  function check(): void {
    if (isStopped()) throw new Error("Telemetry instance is stopped.");
    if (failed) throw new Error("Instrumentation rollback failed; shutdown is required.");
  }

  // Upstream errors clears its flag before removing listeners. Retain the exact handler so
  // partial removals and shutdown reentered from addEventListener can still be cleaned up.
  function rememberErrors(entry: Entry): void {
    if (entry.kind !== "errors") return;
    const handler = (
      entry.instrumentation as BrowserInstrumentation & {
        _onErrorHandler?: EventListener;
      }
    )._onErrorHandler;
    if (handler) (entry.errorHandlers ??= new Set()).add(handler);
  }

  function cleanErrors(entry: Entry): void {
    const errors: unknown[] = [];
    for (const handler of entry.errorHandlers ?? []) {
      for (const name of ["error", "unhandledrejection"]) {
        try {
          window.removeEventListener(name, handler);
        } catch (error) {
          errors.push(error);
        }
      }
    }
    throwErrors(errors, "Instrumentation listener cleanup failed");
    if (!entry.transitioning) entry.errorHandlers?.clear();
  }

  function invoke(entry: Entry, active: boolean): void {
    rememberErrors(entry);
    const errors: unknown[] = [];
    entry.transitioning = true;
    try {
      entry.instrumentation[active ? "enable" : "disable"]();
    } catch (error) {
      errors.push(error);
    } finally {
      entry.transitioning = false;
    }
    rememberErrors(entry);
    if (active && isStopped()) {
      try {
        entry.instrumentation.disable();
      } catch (error) {
        errors.push(error);
      }
    }
    if (!active || isStopped()) {
      try {
        cleanErrors(entry);
      } catch (error) {
        errors.push(error);
      }
    }
    throwErrors(errors, "Instrumentation lifecycle failed");
  }

  function effective(entry: Entry, requested: boolean, policy: Gates): boolean {
    return (
      requested &&
      (entry.kind === "fetch"
        ? tracesEnabled && !policy.disableFetchTracking
        : entry.kind === "xhr"
          ? tracesEnabled && !policy.disableAjaxTracking
          : true)
    );
  }

  function transition(changes: { entry: Entry; active: boolean }[]): void {
    check();
    const attempted: Entry[] = [];
    try {
      for (const { entry, active } of changes) {
        if (entry.active === active) continue;
        attempted.push(entry);
        invoke(entry, active);
        check();
      }
    } catch (error) {
      // A lifecycle exception may follow partial listener changes or hidden adapter cleanup.
      // Inverse calls are best effort, not proof that the original state was restored.
      failed = true;
      const errors = [error];
      for (const entry of attempted.reverse()) {
        try {
          // A synchronous lifecycle callback may have shut the handle down. Never revive it.
          invoke(entry, entry.active && !isStopped());
        } catch (rollbackError) {
          errors.push(rollbackError);
        }
      }
      if (errors.length > 1) {
        throw new AggregateError(errors, "Instrumentation rollback failed; shutdown is required.", {
          cause: error,
        });
      }
      throw error;
    }
    // Keep committed state unchanged until every lifecycle call succeeds; rollback reads it.
    for (const { entry, active } of changes) entry.active = active;
  }

  return {
    enable(): void {
      // Bind directly to this instance, never to the global routing providers.
      for (const instrumentation of instrumentations) {
        instrumentation.setTracerProvider(providers.tracerProvider);
        instrumentation.setLoggerProvider?.(providers.loggerProvider);
        const active = tracesEnabled || !isNetworkInstrumentation(instrumentation);
        if (active && !instrumentation.getConfig().enabled) instrumentation.enable();
        // Do not invoke new application getters merely to assign inspection IDs.
        const name = metadata(instrumentation, "instrumentationName");
        const version = metadata(instrumentation, "instrumentationVersion");
        const kind =
          version === "0.8.1" && typeof name === "string"
            ? /^@opentelemetry\/browser-instrumentation\/(fetch|xhr|console|errors|user-action|web-vitals)$/.exec(
                name,
              )?.[1]
            : undefined;
        const base =
          typeof name === "string"
            ? name.startsWith("@opentelemetry/browser-instrumentation/")
              ? name.slice(name.lastIndexOf("/") + 1)
              : name
            : "instrumentation";
        let id = base;
        let suffix = 2;
        while (entries.has(id)) id = `${base}#${suffix++}`;
        entries.set(id, { instrumentation, kind, requested: true, active });
      }
    },
    check,
    get: (id: string): BrowserInstrumentation | undefined => entries.get(id)?.instrumentation,
    setEnabled(id: string, enabled: boolean): void {
      check();
      if (typeof id !== "string" || typeof enabled !== "boolean") {
        throw new TypeError("Instrumentation ID must be a string and enabled must be a boolean.");
      }
      const entry = entries.get(id);
      if (!entry) throw new Error(`Unknown instrumentation: ${id}`);
      if (!entry.kind)
        throw new Error(`Runtime lifecycle is unsupported for instrumentation: ${id}`);
      transition([{ entry, active: effective(entry, enabled, gates) }]);
      entry.requested = enabled;
    },
    setNetworkGates(next: Gates): void {
      transition(
        [...entries.values()]
          .filter((entry) => entry.kind === "fetch" || entry.kind === "xhr")
          .map((entry) => ({ entry, active: effective(entry, entry.requested, next) })),
      );
      gates = next;
    },
    // The owning handle coalesces shutdown and invokes this once, even after failed startup.
    shutdown(): void {
      for (const entry of entries.values()) rememberErrors(entry);
      const errors: unknown[] = [];
      try {
        release();
      } catch (error) {
        errors.push(error);
      }
      for (const entry of entries.values()) {
        try {
          cleanErrors(entry);
        } catch (error) {
          errors.push(error);
        }
      }
      throwErrors(errors, "Instrumentation cleanup failed");
    },
  };
}
