// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// The page-view instrumentation is intentionally NOT re-exported here. `InstrumentationBase` pulls
// in `@opentelemetry/api`, whose global registration is a module side effect that cannot be
// tree-shaken, so exporting the class from the package entry point would add it to every
// consumer's bundle whether or not they use page views. It is reachable from
// `src/instrumentation/pageView/index.ts` and is wired up through `useMicrosoftOpenTelemetry`.
// Types are erased at build time and are safe to export.
export type {
  ApplyCustomLogRecordDataFunction,
  PageView,
  PageViewContext,
  PageViewDurationSource,
  PageViewInstrumentationConfig,
  PageViewListener,
  PageViewNameSource,
  PageViewNavigationType,
  PageViewSource,
  RouteResolverFunction,
  SanitizeUrlFunction,
} from "./instrumentation/pageView/types.js";
export { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";
export type {
  AzureMonitorOptions,
  InstrumentationOptions,
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
  OtlpOptions,
} from "./types.js";
export { useMicrosoftOpenTelemetry } from "./useMicrosoftOpenTelemetry.js";
