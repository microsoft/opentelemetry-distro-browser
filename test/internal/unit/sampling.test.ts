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
      attributes: {},
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
    [TraceFlags.SAMPLED, getSamplingScore(TRACE_ID), SamplingDecision.NOT_RECORD],
    [TraceFlags.NONE, getSamplingScore(TRACE_ID) + 0.000_001, SamplingDecision.RECORD_AND_SAMPLED],
  ] as const)(
    "uses the trace ID score instead of parent trace flags %s",
    (traceFlags, samplingPercentage, decision) => {
      const parent = trace.setSpanContext(ROOT_CONTEXT, {
        traceId: TRACE_ID,
        spanId: "1111111111111111",
        traceFlags,
        isRemote: true,
      });
      expect(sample(new ApplicationInsightsSampler(samplingPercentage), parent)).toMatchObject({
        decision,
      });
    },
  );

  it("rejects a sampled-parent trace at zero percent", () => {
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: TRACE_ID,
      spanId: "1111111111111111",
      traceFlags: TraceFlags.SAMPLED,
    });

    expect(sample(new ApplicationInsightsSampler(0), parent)).toEqual({
      decision: SamplingDecision.NOT_RECORD,
      attributes: {},
    });
  });

  it("preserves producer-provided sampling metadata", () => {
    const attributes = { [AZURE_MONITOR_SAMPLE_RATE]: 20 };
    const result = new ApplicationInsightsSampler(50).shouldSample(
      ROOT_CONTEXT,
      TRACE_ID,
      "test",
      SpanKind.INTERNAL,
      attributes,
      [],
    );

    expect(result.attributes).toBe(attributes);
    expect(result.attributes).toEqual(attributes);
  });
});
