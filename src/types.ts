// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Microsoft browser distribution configuration for traces and logs.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserOptions {
  /** Configures the default OTLP exporters for traces and logs. */
  otlp?: OtlpOptions;
  /** Replaces the default OTLP span processor when provided. */
  spanProcessors?: SpanProcessor[];
  /** Replaces the default OTLP log record processor when provided. */
  logRecordProcessors?: LogRecordProcessor[];
}

/**
 * Browser OTLP/HTTP destination for both signals.
 * @public
 */
export interface OtlpOptions {
  /** Base collector URL. Defaults to http://localhost:4318; upstream sets the signal paths. */
  endpoint?: string;
  /** Additional HTTP headers sent with OTLP export requests. */
  headers?: Record<string, string>;
}

/**
 * Browser telemetry lifecycle handle.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowser {
  /** Shuts down trace and log providers without unregistering their global APIs. */
  shutdown(): Promise<void>;
}
