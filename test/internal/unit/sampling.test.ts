// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, SpanKind, TraceFlags, trace } from "@opentelemetry/api";
import { SamplingDecision } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
  ApplicationInsightsSampler,
  AZURE_MONITOR_SAMPLE_RATE,
  getSamplingScore,
} from "../../../src/sampling.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";

function sample(sampler: ApplicationInsightsSampler, context = ROOT_CONTEXT) {
  return sampler.shouldSample(context, TRACE_ID, "test", SpanKind.INTERNAL, {}, []);
}

describe("ApplicationInsightsSampler", () => {
  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid percentage %s",
    (percentage) => {
      expect(() => new ApplicationInsightsSampler(percentage)).toThrow(RangeError);
    },
  );

  it("handles the zero and 100 percent boundaries", () => {
    expect(sample(new ApplicationInsightsSampler(0))).toEqual({
      decision: SamplingDecision.NOT_RECORD,
      attributes: { [AZURE_MONITOR_SAMPLE_RATE]: 0 },
    });
    expect(sample(new ApplicationInsightsSampler(100))).toEqual({
      decision: SamplingDecision.RECORD_AND_SAMPLED,
      attributes: {},
    });
  });

  it("makes a deterministic decision from the trace ID", () => {
    const score = getSamplingScore(TRACE_ID);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
    expect(sample(new ApplicationInsightsSampler(score))).toMatchObject({
      decision: SamplingDecision.NOT_RECORD,
    });
    expect(sample(new ApplicationInsightsSampler(score + 0.000_001))).toMatchObject({
      decision: SamplingDecision.RECORD_AND_SAMPLED,
    });
  });

  it("adds the sample rate without mutating input attributes", () => {
    const attributes = { existing: "value" };
    const result = new ApplicationInsightsSampler(50).shouldSample(
      ROOT_CONTEXT,
      TRACE_ID,
      "test",
      SpanKind.INTERNAL,
      attributes,
      [],
    );

    expect(attributes).toEqual({ existing: "value" });
    expect(result.attributes).not.toBe(attributes);
    expect(result.attributes).toEqual({
      existing: "value",
      [AZURE_MONITOR_SAMPLE_RATE]: 50,
    });
  });

  it.each([
    [TraceFlags.SAMPLED, SamplingDecision.RECORD_AND_SAMPLED],
    [TraceFlags.NONE, SamplingDecision.NOT_RECORD],
  ] as const)("honors a valid parent's trace flags", (traceFlags, decision) => {
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "11111111111111111111111111111111",
      spanId: "1111111111111111",
      traceFlags,
      isRemote: true,
    });
    expect(sample(new ApplicationInsightsSampler(50), parent)).toMatchObject({ decision });
  });
});
