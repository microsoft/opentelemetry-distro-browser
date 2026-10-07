// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { TraceFlags, type SpanContext } from "@opentelemetry/api";
import { InMemoryLogRecordExporter, type ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { describe, expect, it } from "vitest";
import { AZURE_MONITOR_SAMPLE_RATE, getSamplingScore } from "../../../src/sampling.js";
import { AzureMonitorSamplingLogRecordProcessor } from "../../../src/samplingLogRecordProcessor.js";

const sampledContext: SpanContext = {
  traceId: "1".repeat(32),
  spanId: "2".repeat(16),
  traceFlags: TraceFlags.SAMPLED,
};
const unsampledContext: SpanContext = { ...sampledContext, traceFlags: TraceFlags.NONE };

function makeRecord(spanContext?: SpanContext): ReadWriteLogRecord {
  const attributes: Record<string, string | number> = {};
  return {
    hrTime: [0, 0],
    hrTimeObserved: [0, 0],
    spanContext,
    resource: resourceFromAttributes({}),
    instrumentationScope: { name: "test" },
    attributes,
    droppedAttributesCount: 0,
    setAttribute(key, value) {
      if (value === undefined) delete attributes[key];
      else attributes[key] = value as string | number;
      return this;
    },
    setAttributes(values) {
      Object.assign(attributes, values);
      return this;
    },
    setBody(body) {
      this.body = body;
      return this;
    },
    setEventName(eventName) {
      this.eventName = eventName;
      return this;
    },
    setSeverityNumber(severityNumber) {
      this.severityNumber = severityNumber;
      return this;
    },
    setSeverityText(severityText) {
      this.severityText = severityText;
      return this;
    },
  };
}

async function exportRecords(
  samplingPercentage: number,
  records: ReadWriteLogRecord[],
  random = () => 0,
): Promise<ReadWriteLogRecord[]> {
  const exporter = new InMemoryLogRecordExporter();
  const processor = new AzureMonitorSamplingLogRecordProcessor(
    {
      exporter,
      samplingPercentage,
      disableAutoFlushOnDocumentHide: true,
    },
    random,
  );
  for (const record of records) processor.onEmit(record);
  await processor.forceFlush();
  const exported = exporter.getFinishedLogRecords() as ReadWriteLogRecord[];
  await processor.shutdown();
  return exported;
}

describe("AzureMonitorSamplingLogRecordProcessor", () => {
  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid percentage %s",
    (samplingPercentage) => {
      expect(
        () =>
          new AzureMonitorSamplingLogRecordProcessor({
            exporter: new InMemoryLogRecordExporter(),
            samplingPercentage,
          }),
      ).toThrow(RangeError);
    },
  );

  it("forwards batch processor options after removing the sampling percentage", async () => {
    const processor = new AzureMonitorSamplingLogRecordProcessor({
      exporter: new InMemoryLogRecordExporter(),
      samplingPercentage: 100,
      maxQueueSize: 17,
    });

    expect((processor as unknown as { _maxQueueSize: number })._maxQueueSize).toBe(17);
    await processor.shutdown();
  });

  it("uses the trace ID score instead of trace flags for correlated records", async () => {
    const score = getSamplingScore(sampledContext.traceId);
    const sampledFlagRejected = makeRecord(sampledContext);
    const unsampledFlagAccepted = makeRecord(unsampledContext);

    expect(await exportRecords(score, [sampledFlagRejected])).toEqual([]);
    expect(await exportRecords(score + 0.000_001, [unsampledFlagAccepted])).toEqual([
      unsampledFlagAccepted,
    ]);
    expect(unsampledFlagAccepted.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(score + 0.000_001);
  });

  it("rejects a sampled-flag correlated record at zero percent", async () => {
    const rejected = makeRecord(sampledContext);

    expect(await exportRecords(0, [rejected])).toEqual([]);
    expect(rejected.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBeUndefined();
  });

  it("preserves producer-provided sampling metadata", async () => {
    const accepted = makeRecord(sampledContext);
    accepted.setAttribute(AZURE_MONITOR_SAMPLE_RATE, 20);

    expect(await exportRecords(50, [accepted])).toEqual([accepted]);
    expect(accepted.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(20);
  });

  it("handles uncorrelated zero and full sampling boundaries", async () => {
    expect(await exportRecords(0, [makeRecord()])).toEqual([]);
    expect(await exportRecords(100, [makeRecord()])).toHaveLength(1);
  });

  it("independently samples uncorrelated records", async () => {
    const accepted = makeRecord();
    const rejected = makeRecord();

    expect(await exportRecords(50, [accepted], () => 0.499)).toEqual([accepted]);
    expect(await exportRecords(50, [rejected], () => 0.5)).toEqual([]);
    expect(accepted.attributes[AZURE_MONITOR_SAMPLE_RATE]).toBe(50);
  });
});
