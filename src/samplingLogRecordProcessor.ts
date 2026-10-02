// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TraceFlags, isSpanContextValid } from "@opentelemetry/api";
import {
  BatchLogRecordProcessor,
  type BatchLogRecordProcessorBrowserOptions,
  type ReadWriteLogRecord,
} from "@opentelemetry/sdk-logs";
import { AZURE_MONITOR_SAMPLE_RATE, validateSamplingPercentage } from "./sampling.js";

export interface AzureMonitorSamplingLogRecordProcessorOptions extends BatchLogRecordProcessorBrowserOptions {
  samplingPercentage: number;
}

export class AzureMonitorSamplingLogRecordProcessor extends BatchLogRecordProcessor {
  private readonly samplingPercentage: number;

  public constructor(
    options: AzureMonitorSamplingLogRecordProcessorOptions,
    private readonly random: () => number = Math.random,
  ) {
    super(options);
    this.samplingPercentage = validateSamplingPercentage(options.samplingPercentage);
  }

  public override onEmit(record: ReadWriteLogRecord): void {
    const spanContext = record.spanContext;
    const sampled =
      spanContext && isSpanContextValid(spanContext)
        ? (spanContext.traceFlags & TraceFlags.SAMPLED) !== 0
        : this.samplingPercentage === 100 ||
          (this.samplingPercentage !== 0 && this.random() * 100 < this.samplingPercentage);
    if (!sampled) return;

    if (this.samplingPercentage !== 100) {
      record.setAttribute(AZURE_MONITOR_SAMPLE_RATE, this.samplingPercentage);
    }
    super.onEmit(record);
  }
}
