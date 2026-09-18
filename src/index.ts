// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";
export {
  BrowserDetector,
  browserDetector,
  UserAgentDetector,
  userAgentDetector,
} from "./resource/index.js";
export type {
  AzureMonitorOptions,
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
  OtlpOptions,
} from "./types.js";
export { useMicrosoftOpenTelemetry } from "./useMicrosoftOpenTelemetry.js";
