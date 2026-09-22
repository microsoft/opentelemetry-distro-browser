// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BatchLogRecordProcessor, InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

export function createInMemoryPipeline() {
  const batchOptions = {
    scheduledDelayMillis: 60_000,
    disableAutoFlushOnDocumentHide: true,
  };
  const spanExporter = new InMemorySpanExporter();
  const spanProcessor = new BatchSpanProcessor(spanExporter, batchOptions);
  const logExporter = new InMemoryLogRecordExporter();
  const logProcessor = new BatchLogRecordProcessor({ exporter: logExporter, ...batchOptions });
  return {
    spanExporter,
    spanProcessor,
    logExporter,
    logProcessor,
    options: {
      spanProcessors: [spanProcessor],
      logRecordProcessors: [logProcessor],
    },
  };
}
