// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createNoopMeter, type Meter } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  type BatchSpanProcessorBrowserOptions,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace";
import { spanItemType, type CustomerSdkStats } from "./exporter/customerSdkStats.js";

/** Observes upstream queue drops without replacing its buffer. */
export function createStatsSpanProcessor(
  options: BatchSpanProcessorBrowserOptions,
  stats: CustomerSdkStats,
): BatchSpanProcessor {
  let currentSpan: ReadableSpan | undefined;
  // The API's no-op meter is shared; keep our override on an instance-local facade.
  const meter = Object.create(createNoopMeter()) as Meter;
  const createCounter = meter.createCounter.bind(meter);
  meter.createCounter = (name, options) =>
    name === "otel.sdk.processor.span.processed"
      ? {
          add: (value, attributes) => {
            if (currentSpan && attributes?.["error.type"] === "queue_full") {
              stats.count("Dropped", spanItemType(currentSpan.kind), "QUEUE_FULL", value);
            }
          },
        }
      : createCounter(name, options);
  const processor = new BatchSpanProcessor({
    ...options,
    selfObsMeterProvider: { getMeter: () => meter },
  });
  const onEnd = processor.onEnd.bind(processor);
  processor.onEnd = (span) => {
    const previous = currentSpan;
    currentSpan = span;
    try {
      onEnd(span);
    } finally {
      currentSpan = previous;
    }
  };
  return processor;
}
