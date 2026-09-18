// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TextMapPropagator } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  type AzureMonitorOptions,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
  type OtlpOptions,
  useMicrosoftOpenTelemetry,
} from "../../../src/index.js";

describe("public initialization contract", () => {
  it("requires options and declares a synchronous lifecycle handle", () => {
    expectTypeOf(useMicrosoftOpenTelemetry).parameters.toEqualTypeOf<
      [MicrosoftOpenTelemetryBrowserOptions]
    >();
    expectTypeOf(useMicrosoftOpenTelemetry).returns.toEqualTypeOf<MicrosoftOpenTelemetryBrowser>();
    expectTypeOf<MicrosoftOpenTelemetryBrowser["forceFlush"]>().toEqualTypeOf<
      () => Promise<void>
    >();
    expectTypeOf<MicrosoftOpenTelemetryBrowser["shutdown"]>().toEqualTypeOf<() => Promise<void>>();
  });

  it("uses upstream types without replacing their contracts", () => {
    expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["resource"]>().toEqualTypeOf<
      Resource | undefined
    >();
    expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["spanProcessors"]>().toEqualTypeOf<
      readonly SpanProcessor[] | undefined
    >();
    expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["logRecordProcessors"]>().toEqualTypeOf<
      readonly LogRecordProcessor[] | undefined
    >();
    expectTypeOf<MicrosoftOpenTelemetryBrowserOptions["propagator"]>().toEqualTypeOf<
      TextMapPropagator | undefined
    >();
  });

  it("requires destination settings and accepts readonly configuration", () => {
    expectTypeOf({}).not.toExtend<AzureMonitorOptions>();
    expectTypeOf({}).not.toExtend<OtlpOptions>();
    const options = {
      azureMonitor: { connectionString: "InstrumentationKey=example", disableBeacon: true },
      otlp: { endpoint: "https://collector.example.com:4318", headers: { "x-tenant": "example" } },
      samplingRatio: 0.5,
      spanProcessors: [],
      logRecordProcessors: [],
    } as const satisfies MicrosoftOpenTelemetryBrowserOptions;

    expectTypeOf(options).toExtend<MicrosoftOpenTelemetryBrowserOptions>();
  });

  it.each([
    {},
    { azureMonitor: { connectionString: "InstrumentationKey=example" } },
    { otlp: { endpoint: "https://collector.example.com:4318" } },
  ] satisfies MicrosoftOpenTelemetryBrowserOptions[])(
    "fails explicitly while runtime initialization is pending: %j",
    (options) => {
      expect(() => useMicrosoftOpenTelemetry(options)).toThrow(
        "Browser initialization is not implemented yet.",
      );
    },
  );

  it("does not take ownership of processors or mutate configuration", () => {
    const processor: SpanProcessor = {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      forceFlush: vi.fn(),
      shutdown: vi.fn(),
    };
    const options = Object.freeze({
      spanProcessors: Object.freeze([processor]),
    });

    expect(() => useMicrosoftOpenTelemetry(options)).toThrow("not implemented");
    expect(options.spanProcessors).toEqual([processor]);
    expect(processor.onStart).not.toHaveBeenCalled();
    expect(processor.onEnd).not.toHaveBeenCalled();
    expect(processor.forceFlush).not.toHaveBeenCalled();
    expect(processor.shutdown).not.toHaveBeenCalled();
  });
});
