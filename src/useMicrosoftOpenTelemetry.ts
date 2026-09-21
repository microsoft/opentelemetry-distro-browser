// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "./types.js";

/**
 * Entry point for initializing the single-instance browser distribution.
 *
 * @remarks
 * This change establishes the public contract only. Until runtime initialization
 * is implemented, every call throws before registering globals, taking ownership
 * of processors, or modifying browser APIs.
 *
 * When initialization lands, the trace and log providers are given the resource returned by
 * `detectBrowserResource(options.resource)`. No browser detector runs unless the caller opts in
 * through `options.resource`.
 *
 * @param options - Configuration for the browser distribution.
 * @returns The lifecycle handle once runtime initialization is implemented.
 * @throws Error - Runtime initialization is not implemented.
 * @public
 */
export function useMicrosoftOpenTelemetry(
  options: MicrosoftOpenTelemetryBrowserOptions,
): MicrosoftOpenTelemetryBrowser {
  void options;
  throw new Error("Browser initialization is not implemented yet.");
}
