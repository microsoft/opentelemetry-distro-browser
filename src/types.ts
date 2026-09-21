// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { WebSdk, startBrowserSdk } from "@opentelemetry/browser-sdk";

/**
 * Upstream browser SDK configuration for traces and logs.
 * @public
 */
export type MicrosoftOpenTelemetryBrowserOptions = Parameters<typeof startBrowserSdk>[0];

/**
 * Upstream lifecycle handle. Exposes shutdown(), not forceFlush().
 * @public
 */
export type MicrosoftOpenTelemetryBrowser = WebSdk;
