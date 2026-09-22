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
    traces: { processors: options.spanProcessors },
    logs: { processors: options.logRecordProcessors },
  });
}
