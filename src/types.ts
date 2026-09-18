// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TextMapPropagator } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Azure Monitor destination configuration.
 * @public
 */
export interface AzureMonitorOptions {
  /** Application Insights connection string, including sovereign cloud endpoints. */
  readonly connectionString: string;
  /**
   * Disable the sendBeacon fallback on page unload.
   * @defaultValue false
   */
  readonly disableBeacon?: boolean;
}

/**
 * OTLP/HTTP destination configuration for traces and logs.
 * @public
 */
export interface OtlpOptions {
  /** Base OTLP/HTTP endpoint, before the signal-specific paths. */
  readonly endpoint: string;
  /** Additional headers on export requests. */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * Base configuration contract for the browser distribution.
 *
 * @remarks
 * Initialization is not implemented yet. These options describe the intended
 * runtime contract; passing them to useMicrosoftOpenTelemetry currently throws.
 * Instrumentation and session configuration will be defined separately.
 *
 * @public
 */
export interface MicrosoftOpenTelemetryBrowserOptions {
  /** Enable Azure Monitor export with the specified destination. */
  readonly azureMonitor?: AzureMonitorOptions;
  /** Enable OTLP/HTTP export with the specified destination. */
  readonly otlp?: OtlpOptions;
  /** Upstream resource to combine with the distribution's detected resource. */
  readonly resource?: Resource;
  /**
   * Trace sampling ratio, from 0 through 1 inclusive.
   * @defaultValue 1
   */
  readonly samplingRatio?: number;
  /**
   * Additional upstream span processors, including processors wrapping custom
   * exporters. Ownership transfers to the distribution on successful initialization.
   */
  readonly spanProcessors?: readonly SpanProcessor[];
  /**
   * Additional upstream log record processors, including processors wrapping custom
   * exporters. Ownership transfers to the distribution on successful initialization.
   */
  readonly logRecordProcessors?: readonly LogRecordProcessor[];
  /**
   * Upstream context propagator.
   * @defaultValue W3C Trace Context and Baggage
   */
  readonly propagator?: TextMapPropagator;
}

/**
 * Lifecycle handle for a single browser distribution instance.
 *
 * @remarks
 * Applications emit telemetry through the standard OpenTelemetry trace and logs
 * APIs, not through this handle. The handle does not expose providers or routing.
 *
 * @public
 */
export interface MicrosoftOpenTelemetryBrowser {
  /**
   * Flush both trace and log pipelines.
   *
   * @returns A promise that resolves when both pipelines finish flushing, or
   * rejects if either fails, including an upstream flush timeout.
   */
  forceFlush(): Promise<void>;
  /**
   * Shut down both trace and log pipelines and release owned resources.
   * Repeated calls share the same shutdown operation and result.
   *
   * @returns A promise that resolves when both pipelines finish shutting down,
   * or rejects if either fails.
   */
  shutdown(): Promise<void>;
}
