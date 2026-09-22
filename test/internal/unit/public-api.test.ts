// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { expectTypeOf, it } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
  type OtlpOptions,
} from "../../../src/index.js";

it("exposes distro-owned configuration and lifecycle contracts", () => {
  expectTypeOf(useMicrosoftOpenTelemetry)
    .parameter(0)
    .toEqualTypeOf<MicrosoftOpenTelemetryBrowserOptions | undefined>();
  expectTypeOf(useMicrosoftOpenTelemetry).returns.toEqualTypeOf<MicrosoftOpenTelemetryBrowser>();
  expectTypeOf<keyof MicrosoftOpenTelemetryBrowserOptions>().toEqualTypeOf<
    "otlp" | "spanProcessors" | "logRecordProcessors"
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["otlp"]>().toEqualTypeOf<
    OtlpOptions | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["spanProcessors"]>().toEqualTypeOf<
    SpanProcessor[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["logRecordProcessors"]>().toEqualTypeOf<
    LogRecordProcessor[] | undefined
  >();
  expectTypeOf<MicrosoftOpenTelemetryBrowser>().not.toHaveProperty("forceFlush");
});
