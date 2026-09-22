// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TracerProvider } from "@opentelemetry/api";
import type { LoggerProvider } from "@opentelemetry/api-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * The trace and log registration contract implemented by OpenTelemetry instrumentations.
 *
 * @remarks
 * This browser-only subset accepts upstream instrumentation instances without exposing the
 * Node-specific declarations from `@opentelemetry/instrumentation`. Metrics are not initialized
 * by this distribution.
 *
 * @public
 */
export interface BrowserInstrumentation {
  /** Binds the instrumentation to the active tracer provider. */
  setTracerProvider(provider: TracerProvider): void;
  /** Binds log-producing instrumentations to the active logger provider. */
  setLoggerProvider?(provider: LoggerProvider): void;
  /** Returns the instrumentation's configuration without modifying it. */
  getConfig(): { enabled?: boolean };
  /** Starts observing when construction was deferred with `enabled: false`. */
  enable(): void;
  /** Stops observing before telemetry providers shut down. */
  disable(): void;
}

/**
 * Microsoft browser distribution configuration for traces and logs.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserOptions {
  /** Span processors to register with the tracer provider. */
  spanProcessors?: SpanProcessor[];
  /** Log record processors to register with the logger provider. */
  logRecordProcessors?: LogRecordProcessor[];
  /**
   * Individually imported OpenTelemetry instrumentation instances to register.
   *
   * @remarks
   * No instrumentations are included by default. Construct selected instances with
   * `enabled: false` to defer collection until their trace and log providers are bound.
   * Like OpenTelemetry's registration API, registration enables those instances; omit an
   * instance from this array to opt out. Already-enabled instances are rebound without
   * calling `enable()` again, but telemetry emitted before initialization cannot be recovered.
   *
   * The returned handle owns disabling these instances. Do not share them between SDKs.
   * Configure collection filters and sanitization on each instance before registration.
   */
  instrumentations?: readonly BrowserInstrumentation[];
}

/**
 * Browser telemetry lifecycle handle.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowser {
  /**
   * Disables registered instrumentations, then shuts down trace and log providers.
   * Does not unregister global APIs. Cleanup continues if an instrumentation throws,
   * and the returned promise rejects with the cleanup failure(s).
   */
  shutdown(): Promise<void>;
}
