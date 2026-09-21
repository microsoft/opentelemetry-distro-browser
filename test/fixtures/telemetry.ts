// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BatchLogRecordProcessor, InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

const batchOptions = {
  scheduledDelayMillis: 60_000,
  disableAutoFlushOnDocumentHide: true,
};

export function createTracePipeline() {
  const spanExporter = new InMemorySpanExporter();
  const spanProcessor = new BatchSpanProcessor(spanExporter, batchOptions);
  return { spanExporter, spanProcessor, options: { processors: [spanProcessor] } };
}

export function createLogPipeline() {
  const logExporter = new InMemoryLogRecordExporter();
  const logProcessor = new BatchLogRecordProcessor({ exporter: logExporter, ...batchOptions });
  return { logExporter, logProcessor, options: { processors: [logProcessor] } };
}

export function createInMemoryPipeline() {
  const traces = createTracePipeline();
  const logs = createLogPipeline();
  return {
    ...traces,
    ...logs,
    options: { traces: traces.options, logs: logs.options },
  };
}
