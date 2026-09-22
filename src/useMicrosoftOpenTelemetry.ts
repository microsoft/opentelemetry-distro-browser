// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "./types.js";

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
  const instrumentations = options.instrumentations?.slice() ?? [];
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
