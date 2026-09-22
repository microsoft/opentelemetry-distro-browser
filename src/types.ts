// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { PageViewInstrumentationConfig } from "./instrumentation/pageView/types.js";

/**
 * Per-instrumentation configuration.
 *
 * @remarks
 * Instrumentations are named by the occurrence they capture, not by the package that produces
 * them. Each is individually enableable, and omitting an entry leaves that instrumentation at its
 * default state. Additional instrumentations are added here as they land.
 *
 * @public
 */
export interface InstrumentationOptions {
  /**
   * Page views for the initial document load and for single-page-application route changes.
   *
   * @remarks
   * Emits one `browser.page_view` log record per navigation. Upstream
   * `@opentelemetry/browser-instrumentation` has no page-view concept, so this instrumentation is
   * distribution-owned. Enabling it alongside the upstream `navigation` module produces two
   * records per navigation; prefer one or the other.
   */
  readonly pageView?: PageViewInstrumentationConfig;
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
   * Per-instrumentation configuration.
   *
   * @remarks
   * Omitted instrumentations keep their default state.
   */
  instrumentationOptions?: InstrumentationOptions;
}

/**
 * Browser telemetry lifecycle handle.
 * @public
 */
export interface MicrosoftOpenTelemetryBrowser {
  /** Shuts down trace and log providers without unregistering their global APIs. */
  shutdown(): Promise<void>;
}
