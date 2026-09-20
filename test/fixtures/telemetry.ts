// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { BatchLogRecordProcessor, InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

export function createInMemoryPipeline() {
  const spanExporter = new InMemorySpanExporter();
  const logExporter = new InMemoryLogRecordExporter();
  const batchOptions = {
    scheduledDelayMillis: 60_000,
    disableAutoFlushOnDocumentHide: true,
  };
  const spanProcessor = new BatchSpanProcessor(spanExporter, batchOptions);
  const logProcessor = new BatchLogRecordProcessor({ exporter: logExporter, ...batchOptions });

  return {
    spanExporter,
    logExporter,
    spanProcessor,
    logProcessor,
    options: {
      spanProcessors: [spanProcessor],
      logRecordProcessors: [logProcessor],
    },
  };
}
