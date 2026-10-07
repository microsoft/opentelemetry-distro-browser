// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { trace, type Attributes, type Context } from "@opentelemetry/api";
import {
  AlwaysOnSampler,
  ParentBasedSampler,
  SamplingDecision,
  type Sampler,
  type SamplingResult,
} from "@opentelemetry/sdk-trace-base";
import { syntheticPageContexts } from "./shared/pageOperationContext.js";

export const AZURE_MONITOR_SAMPLE_RATE = "microsoft.sample_rate";

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

export function validateSamplingPercentage(percentage: number): number {
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new RangeError("samplingPercentage must be a finite number between 0 and 100.");
  }
  return percentage;
}

export function getSamplingScore(traceId: string): number {
  if (!traceId) return 0;

  let input = traceId;
  // Preserve Application Insights cross-SDK scoring for legacy operation IDs shorter than 8 chars.
  while (input.length < 8) input += input;

  let hash = 5381;
  for (let index = 0; index < input.length; index++) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) | 0;
  }
  hash = hash <= INT32_MIN ? INT32_MAX : Math.abs(hash);
  return (hash / INT32_MAX) * 100;
}

export function isTraceSampled(traceId: string, samplingPercentage: number): boolean {
  if (samplingPercentage === 100) return true;
  if (samplingPercentage === 0) return false;
  return getSamplingScore(traceId) < samplingPercentage;
}

export function shouldSetSampleRate(
  currentSampleRate: unknown,
  samplingPercentage: number,
): boolean {
  return (
    currentSampleRate !== samplingPercentage &&
    (samplingPercentage < 100 || currentSampleRate !== undefined)
  );
}

/** Applies SDK-default sampling without inheriting another provider's synthetic page decision. */
export class PageOperationSampler implements Sampler {
  private readonly delegate = new ParentBasedSampler({ root: new AlwaysOnSampler() });

  public shouldSample(
    parentContext: Context,
    ...parameters: Parameters<Sampler["shouldSample"]> extends [Context, ...infer Rest]
      ? Rest
      : never
  ): SamplingResult {
    const parent = trace.getSpanContext(parentContext);
    const samplingContext =
      parent && syntheticPageContexts.has(parent) ? trace.deleteSpan(parentContext) : parentContext;
    return this.delegate.shouldSample(samplingContext, ...parameters);
  }

  public toString(): string {
    return `PageOperationSampler{${this.delegate.toString()}}`;
  }
}

export class ApplicationInsightsSampler implements Sampler {
  public readonly samplingPercentage: number;

  public constructor(samplingPercentage = 100) {
    this.samplingPercentage = validateSamplingPercentage(samplingPercentage);
  }

  public shouldSample(
    _parentContext: Context,
    traceId: string,
    _spanName: Parameters<Sampler["shouldSample"]>[2],
    _spanKind: Parameters<Sampler["shouldSample"]>[3],
    attributes: Attributes,
    _links: Parameters<Sampler["shouldSample"]>[5],
  ): SamplingResult {
    const sampled = isTraceSampled(traceId, this.samplingPercentage);
    const currentSampleRate = attributes[AZURE_MONITOR_SAMPLE_RATE];
    const setSampleRate =
      sampled && shouldSetSampleRate(currentSampleRate, this.samplingPercentage);
    return {
      decision: sampled ? SamplingDecision.RECORD_AND_SAMPLED : SamplingDecision.NOT_RECORD,
      attributes: setSampleRate
        ? { ...attributes, [AZURE_MONITOR_SAMPLE_RATE]: this.samplingPercentage }
        : attributes,
    };
  }

  public toString(): string {
    return `ApplicationInsightsSampler{${this.samplingPercentage}}`;
  }
}
