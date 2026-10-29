// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TracerProvider } from "@opentelemetry/api";
import type { Logger, LoggerProvider, LogRecord } from "@opentelemetry/api-logs";
import type { BrowserInstrumentation } from "../types.js";
import { redactUrl } from "../shared/urlRedaction.js";

/** Custom properties accepted by the Application Insights-style framework helpers. @public */
export type CustomProperties = Record<string, unknown>;

/** Application Insights severity: verbose, information, warning, error, critical. @public */
export type FrameworkSeverityLevel = 0 | 1 | 2 | 3 | 4;

/** A named custom event. @public */
export interface EventTelemetry {
  name: string;
  properties?: CustomProperties;
}

/** A component metric, represented as a log because this distro has no metrics provider. @public */
export interface MetricTelemetry {
  name: string;
  average: number;
  sampleCount?: number;
  min?: number;
  max?: number;
  stdDev?: number;
  properties?: CustomProperties;
}

/** An exception captured by a framework instead of a browser global error handler. @public */
export interface ExceptionTelemetry {
  exception?: unknown;
  error?: unknown;
  severityLevel?: FrameworkSeverityLevel;
  properties?: CustomProperties;
}

/** An application trace message. @public */
export interface TraceTelemetry {
  message: string;
  severityLevel?: FrameworkSeverityLevel;
  properties?: CustomProperties;
}

/** An explicitly tracked page view; do not also automatically track the same navigation. @public */
export interface PageViewTelemetry {
  name?: string;
  uri?: string;
  duration?: number;
  properties?: CustomProperties;
}

function properties(input?: CustomProperties): NonNullable<LogRecord["attributes"]> {
  const result: NonNullable<LogRecord["attributes"]> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      result[key] = value;
    } else {
      try {
        result[key] = JSON.stringify(value);
      } catch {
        // A cyclic custom property must not break rendering or error handling.
      }
    }
  }
  return result;
}

/**
 * Instance-bound telemetry shared by the framework adapters. Register the adapter in
 * `instrumentations` before using its tracking methods. No global logger is consulted, and
 * disabled adapters drop telemetry rather than falling back to another SDK instance.
 *
 * @remarks
 * Mirrors the framework extensions' tracking methods, not the Application Insights plugin
 * protocol, cookie manager or AnalyticsPlugin. Azure Monitor maps component metric logs to
 * custom metrics; OTLP consumers receive portable `browser.custom_metric` log records.
 * @public
 */
export class FrameworkPlugin implements BrowserInstrumentation {
  #logger: Logger | undefined;
  #enabled = false;
  #sanitizeUrl: (url: string) => string = redactUrl;

  public constructor(private readonly scope: string) {}

  /** Framework helpers produce logs, not spans. */
  public setTracerProvider(_provider: TracerProvider): void {}

  /** Called by the distribution with this instance's own provider. */
  public setLoggerProvider(provider: LoggerProvider): void {
    this.#logger = provider.getLogger(this.scope);
  }

  /** Called by the distribution to share its configured URL redaction and sanitization. */
  public setUrlSanitizer(sanitize: (url: string) => string): void {
    this.#sanitizeUrl = sanitize;
  }

  public getConfig(): { enabled: boolean } {
    return { enabled: this.#enabled };
  }

  public enable(): void {
    this.#enabled = true;
  }

  public disable(): void {
    this.#enabled = false;
  }

  /** Mirrors the React extension's analytics accessor without an AnalyticsPlugin dependency. */
  public getAppInsights(): FrameworkPlugin {
    return this;
  }

  public trackEvent(event: EventTelemetry, customProperties?: CustomProperties): void {
    this.emit({
      eventName: event.name,
      severityNumber: 9,
      attributes: properties({ ...event.properties, ...customProperties }),
    });
  }

  public trackMetric(metric: MetricTelemetry, customProperties?: CustomProperties): void {
    const count = metric.sampleCount ?? 1;
    if (
      !metric.name.trim() ||
      !Number.isFinite(metric.average) ||
      !Number.isSafeInteger(count) ||
      count <= 0
    )
      return;
    this.emit({
      eventName: "browser.custom_metric",
      severityNumber: 9,
      attributes: {
        ...properties({ ...metric.properties, ...customProperties }),
        "metric.name": metric.name,
        "metric.value": metric.average,
        "metric.count": count,
        "metric.min": metric.min,
        "metric.max": metric.max,
        "metric.stddev": metric.stdDev,
      },
    });
  }

  public trackException(exception: ExceptionTelemetry, customProperties?: CustomProperties): void {
    const error = exception.exception ?? exception.error;
    this.emit({
      eventName: "exception",
      severityNumber: this.severity(exception.severityLevel ?? 3),
      attributes: {
        ...properties({ ...exception.properties, ...customProperties }),
        "exception.type": error instanceof Error ? error.name : "Error",
        "exception.message": error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { "exception.stacktrace": error.stack } : {}),
      },
    });
  }

  public trackTrace(trace: TraceTelemetry, customProperties?: CustomProperties): void {
    this.emit({
      body: trace.message,
      severityNumber: this.severity(trace.severityLevel ?? 1),
      attributes: properties({ ...trace.properties, ...customProperties }),
    });
  }

  /** Explicit page tracking is independent of the automatic router source. */
  public trackPageView(pageView: PageViewTelemetry): void {
    let url: string | undefined;
    try {
      if (pageView.uri) {
        url = this.#sanitizeUrl(
          new URL(pageView.uri, typeof location === "undefined" ? undefined : location.href).href,
        );
      }
    } catch {
      // Invalid URLs must not bypass credential redaction.
    }
    this.emit({
      eventName: "browser.page_view",
      severityNumber: 9,
      attributes: {
        ...properties(
          Object.fromEntries(
            Object.entries(pageView.properties ?? {}).filter(
              ([key]) => key !== "url.full" && key !== "browser.page_view.referrer",
            ),
          ),
        ),
        "browser.page_view.name":
          pageView.name ?? (typeof document === "undefined" ? "" : document.title),
        "browser.page_view.name_source": pageView.name ? "explicit" : "document_title",
        "browser.page_view.duration": pageView.duration ?? 0,
        ...(url ? { "url.full": url } : {}),
      },
    });
  }

  protected emit(record: LogRecord): void {
    if (!this.#enabled) return;
    try {
      this.#logger?.emit(record);
    } catch {
      // Telemetry must not replace an application exception or break a framework callback.
    }
  }

  private severity(level: FrameworkSeverityLevel): 1 | 9 | 13 | 17 | 21 {
    return ([1, 9, 13, 17, 21] as const)[level];
  }
}
