// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

export { ReactPlugin } from "./ReactPlugin.js";
export type { IReactExtensionConfig } from "./ReactPlugin.js";
export { AppInsightsContext, useAppInsightsContext } from "./AppInsightsContext.js";
export { AppInsightsErrorBoundary } from "./AppInsightsErrorBoundary.js";
export type {
  IAppInsightsErrorBoundaryFallbackProps,
  IAppInsightsErrorBoundaryProps,
  IAppInsightsErrorBoundaryState,
} from "./AppInsightsErrorBoundary.js";
export { AITrackedComponentBase, useTrackMetric, withAITracking } from "./engagement.js";
export { useTrackEvent } from "./useTrackEvent.js";
export type { AIReactCustomEvent } from "./useTrackEvent.js";
export { FrameworkPlugin } from "../telemetry.js";
export type {
  CustomProperties,
  EventTelemetry,
  ExceptionTelemetry,
  FrameworkSeverityLevel,
  MetricTelemetry,
  PageViewTelemetry,
  TraceTelemetry,
} from "../telemetry.js";
export type { PageViewInstrumentationConfig } from "../../instrumentation/pageView/types.js";
export type { BrowserInstrumentation } from "../../types.js";
