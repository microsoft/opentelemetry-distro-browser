// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

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
  return startBrowserSdk({
    exportConfig: {
      url: options.otlp?.endpoint,
      headers: options.otlp?.headers,
    },
    // Per-signal export configs retain OTLP with custom processors; upstream sets the URLs.
    traces: {
      processors: options.spanProcessors,
      exportConfig: options.otlp ? { headers: options.otlp.headers } : undefined,
    },
    logs: {
      processors: options.logRecordProcessors,
      exportConfig: options.otlp ? { headers: options.otlp.headers } : undefined,
    },
  });
}
