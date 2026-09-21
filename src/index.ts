// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";
export type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "./types.js";
export { startBrowserSdk as useMicrosoftOpenTelemetry } from "@opentelemetry/browser-sdk";
