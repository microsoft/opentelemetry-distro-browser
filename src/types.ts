// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Microsoft browser distribution configuration for traces and logs.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserOptions {
  /** Span processors to register with the tracer provider. */
  spanProcessors?: SpanProcessor[];
  /** Log record processors to register with the logger provider. */
  logRecordProcessors?: LogRecordProcessor[];
}

/**
 * Browser telemetry lifecycle handle.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowser {
  /** Shuts down trace and log providers without unregistering their global APIs. */
  shutdown(): Promise<void>;
}
