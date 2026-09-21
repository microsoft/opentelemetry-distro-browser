// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { WebSdk, startBrowserSdk } from "@opentelemetry/browser-sdk";
import { expectTypeOf, it } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";

it("uses the upstream configuration and lifecycle contracts unchanged", () => {
  expectTypeOf(useMicrosoftOpenTelemetry).toEqualTypeOf<typeof startBrowserSdk>();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions>().toEqualTypeOf<
    Parameters<typeof startBrowserSdk>[0]
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowser>().toEqualTypeOf<WebSdk>();
  expectTypeOf<MicrosoftOpenTelemetryBrowser>().not.toHaveProperty("forceFlush");
});
