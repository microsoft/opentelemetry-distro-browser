// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LogsConfig, TracesConfig, WebSdk, startBrowserSdk } from "@opentelemetry/browser-sdk";
import type { startLogsSdk } from "@opentelemetry/browser-sdk/logs";
import type { startTracesSdk } from "@opentelemetry/browser-sdk/traces";
import { expectTypeOf, it } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  useMicrosoftOpenTelemetryLogs,
  useMicrosoftOpenTelemetryTraces,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
  type MicrosoftOpenTelemetryBrowserLogOptions,
  type MicrosoftOpenTelemetryBrowserTraceOptions,
} from "../../../src/index.js";

it("uses the upstream configuration and lifecycle contracts unchanged", () => {
  expectTypeOf(useMicrosoftOpenTelemetry).toEqualTypeOf<typeof startBrowserSdk>();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions>().toEqualTypeOf<
    Parameters<typeof startBrowserSdk>[0]
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserLogOptions>().toEqualTypeOf<LogsConfig>();
  expectTypeOf<MicrosoftOpenTelemetryBrowserTraceOptions>().toEqualTypeOf<TracesConfig>();
  expectTypeOf(useMicrosoftOpenTelemetryLogs).toEqualTypeOf<typeof startLogsSdk>();
  expectTypeOf(useMicrosoftOpenTelemetryTraces).toEqualTypeOf<typeof startTracesSdk>();
  expectTypeOf<MicrosoftOpenTelemetryBrowser>().toEqualTypeOf<WebSdk>();
  expectTypeOf<MicrosoftOpenTelemetryBrowser>().not.toHaveProperty("forceFlush");
});
