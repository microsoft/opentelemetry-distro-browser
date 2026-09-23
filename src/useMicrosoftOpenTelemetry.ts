// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { PageViewInstrumentation } from "./instrumentation/pageView/index.js";
import type {
  BrowserInstrumentation,
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "./types.js";

/**
 * Builds the instrumentations this distribution owns and turns on by itself.
 *
 * @remarks
 * Distribution-owned instrumentations are selected by configuration rather than by import,
 * because a bundler resolves imports before the application ever supplies its options. Page view
 * is on unless it is switched off.
 *
 * Returns nothing outside a browser. This entry point is routinely imported by a server-rendered
 * build, and these instrumentations observe the DOM, so constructing one there would throw during
 * initialization and take the host application down with it.
 *
 * Each is constructed with `enabled: false` so that collection starts only once the registration
 * loop below has bound its trace and log providers.
 */
function createOwnedInstrumentations(
  options: MicrosoftOpenTelemetryBrowserOptions,
): BrowserInstrumentation[] {
  if (typeof document === "undefined" || typeof location === "undefined") return [];

  const owned: BrowserInstrumentation[] = [];
  const pageView = options.pageView ?? {};
  if (pageView.enabled !== false) {
    owned.push(new PageViewInstrumentation({ ...pageView, enabled: false }));
  }
  return owned;
}

/**
 * Initializes traces and logs using Microsoft browser distribution options.
 * @public
 */
export function useMicrosoftOpenTelemetry(
  options: MicrosoftOpenTelemetryBrowserOptions = {},
): MicrosoftOpenTelemetryBrowser {
  const sdk = startBrowserSdk({
    traces: { processors: options.spanProcessors },
    logs: { processors: options.logRecordProcessors },
  });
  // Distribution-owned instrumentations come last, so an application-supplied instance observing
  // the same API is installed first and is disabled last.
  const instrumentations = [
    ...(options.instrumentations ?? []),
    ...createOwnedInstrumentations(options),
  ];
  if (instrumentations.length === 0) return sdk;

  let shutdownPromise: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    return (shutdownPromise ??= (async () => {
      const errors: unknown[] = [];
      for (let i = instrumentations.length - 1; i >= 0; i--) {
        try {
          instrumentations[i].disable();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await sdk.shutdown();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Telemetry shutdown failed");
    })());
  }

  try {
    const tracerProvider = trace.getTracerProvider();
    const loggerProvider = logs.getLoggerProvider();
    for (const instrumentation of instrumentations) {
      instrumentation.setTracerProvider(tracerProvider);
      instrumentation.setLoggerProvider?.(loggerProvider);
      if (!instrumentation.getConfig().enabled) instrumentation.enable();
    }
  } catch (error) {
    // Initialization stays synchronous; report asynchronous rollback failures through OTel.
    void shutdown().catch((cleanupError: unknown) => {
      diag.error("Instrumentation initialization cleanup failed", cleanupError);
    });
    throw error;
  }

  return { shutdown };
}
