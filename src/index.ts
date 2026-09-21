// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";
export type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserLogOptions,
  MicrosoftOpenTelemetryBrowserOptions,
  MicrosoftOpenTelemetryBrowserTraceOptions,
} from "./types.js";
export { startBrowserSdk as useMicrosoftOpenTelemetry } from "@opentelemetry/browser-sdk";
export { startLogsSdk as useMicrosoftOpenTelemetryLogs } from "@opentelemetry/browser-sdk/logs";
export { startTracesSdk as useMicrosoftOpenTelemetryTraces } from "@opentelemetry/browser-sdk/traces";
