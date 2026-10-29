// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TelemetryInstance } from "../routing/telemetryInstance.js";
import type { BrowserInstrumentation } from "../types.js";
import { claimInstrumentations, isNetworkInstrumentation } from "./sharedBrowserPatches.js";

/** Owns the initial instrumentation snapshot for one instance, without changing shared patches. */
export function createInstrumentationRegistry(
  instrumentations: readonly BrowserInstrumentation[],
  providers: Pick<TelemetryInstance, "tracerProvider" | "loggerProvider">,
  tracesEnabled: boolean,
) {
  // Claim the whole list before any application callback can bind or enable an entry.
  const release = claimInstrumentations(instrumentations);
  return {
    enable(): void {
      // Bind directly to this instance, never to the global routing providers.
      for (const instrumentation of instrumentations) {
        instrumentation.setTracerProvider(providers.tracerProvider);
        instrumentation.setLoggerProvider?.(providers.loggerProvider);
        if (!tracesEnabled && isNetworkInstrumentation(instrumentation)) continue;
        if (!instrumentation.getConfig().enabled) instrumentation.enable();
      }
    },
    // The owning handle coalesces shutdown and invokes this once, even after failed startup.
    shutdown: release,
  };
}
