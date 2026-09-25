// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  AzureMonitorExportClient,
  AzureMonitorExporterBase,
  type AzureMonitorOptions,
} from "./base.js";
import { spanToEnvelope } from "./spanUtils.js";

/**
 * Exports OpenTelemetry spans to Azure Monitor.
 * @public
 */
export class AzureMonitorSpanExporter extends AzureMonitorExporterBase implements SpanExporter {
  public constructor(options: AzureMonitorOptions) {
    super(new AzureMonitorExportClient(options));
  }

  public export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    this.client.export(
      spans.map((span) => spanToEnvelope(span, this.client.instrumentationKey)),
      callback,
    );
  }
}
