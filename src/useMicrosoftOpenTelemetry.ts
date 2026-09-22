// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { createInstrumentations } from "./instrumentation/index.js";
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

  // After the SDK, never before: instrumentations resolve their logger when they are constructed,
  // and the SDK registers the logger provider inside `startBrowserSdk`.
  const instrumentations = createInstrumentations(options.instrumentationOptions);

  return {
    async shutdown(): Promise<void> {
      // Stop observing before the providers go away, so nothing is recorded into a dead pipeline.
      for (const instrumentation of instrumentations) {
        instrumentation.disable();
      }
      await sdk.shutdown();
    },
  };
}
