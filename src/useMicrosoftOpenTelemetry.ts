// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import {
  createSessionLogRecordProcessor,
  createSessionSpanProcessor,
} from "@opentelemetry/browser-sdk/session";
import { createSession } from "./session/createSession.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "./types.js";

/**
 * Restores the session, then initializes traces, logs, and selected instrumentations.
 * Await completion before emitting telemetry.
 * @public
 */
export async function useMicrosoftOpenTelemetry(
  options: MicrosoftOpenTelemetryBrowserOptions = {},
): Promise<MicrosoftOpenTelemetryBrowser> {
  const session = createSession();
  const spanProcessors = options.spanProcessors?.slice();
  const logRecordProcessors = options.logRecordProcessors?.slice();
  const instrumentations = options.instrumentations?.slice() ?? [];
  let sdk: MicrosoftOpenTelemetryBrowser | undefined;
  let stopping = false;
  // Upstream stale tracers can still call processors after provider shutdown.
  const sessionProvider = {
    getSessionId: () => (stopping ? null : session.getSessionId()),
  };

  let shutdownPromise: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    return (shutdownPromise ??= (async () => {
      stopping = true;
      const errors: unknown[] = [];
      for (let i = sdk ? instrumentations.length - 1 : -1; i >= 0; i--) {
        try {
          instrumentations[i].disable();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await sdk?.shutdown();
      } catch (error) {
        errors.push(error);
      } finally {
        session.shutdown();
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Telemetry shutdown failed");
    })());
  }

  try {
    await session.start();
    sdk = startBrowserSdk({
      traces: {
        processors: [createSessionSpanProcessor(sessionProvider), ...(spanProcessors ?? [])],
        // Supplying enrichment processors must not disable upstream default export.
        ...(spanProcessors === undefined ? { exportConfig: {} } : {}),
      },
      logs: {
        processors: [
          createSessionLogRecordProcessor(sessionProvider),
          ...(logRecordProcessors ?? []),
        ],
        ...(logRecordProcessors === undefined ? { exportConfig: {} } : {}),
      },
    });
    const tracerProvider = trace.getTracerProvider();
    const loggerProvider = logs.getLoggerProvider();
    for (const instrumentation of instrumentations) {
      instrumentation.setTracerProvider(tracerProvider);
      instrumentation.setLoggerProvider?.(loggerProvider);
      if (!instrumentation.getConfig().enabled) instrumentation.enable();
    }
  } catch (error) {
    try {
      await shutdown();
    } catch (cleanupError) {
      diag.error("Telemetry initialization cleanup failed", cleanupError);
    }
    throw error;
  }

  return { shutdown };
}
