// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LogsConfig, TracesConfig, WebSdk, startBrowserSdk } from "@opentelemetry/browser-sdk";

/**
 * Upstream browser SDK configuration for traces and logs.
 * @public
 */
export type MicrosoftOpenTelemetryBrowserOptions = Parameters<typeof startBrowserSdk>[0];

/**
 * Upstream configuration for the trace-only initializer.
 * @public
 */
export type MicrosoftOpenTelemetryBrowserTraceOptions = TracesConfig;

/**
 * Upstream configuration for the log-only initializer.
 * @public
 */
export type MicrosoftOpenTelemetryBrowserLogOptions = LogsConfig;

/**
 * Upstream lifecycle handle. Exposes shutdown(), not forceFlush().
 * @public
 */
export type MicrosoftOpenTelemetryBrowser = WebSdk;
