// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import {
  AzureMonitorExportClient,
  AzureMonitorExporterBase,
  type AzureMonitorOptions,
} from "./base.js";
import { logToEnvelope } from "./logUtils.js";

/**
 * Exports OpenTelemetry log records to Azure Monitor.
 * @public
 */
export class AzureMonitorLogRecordExporter
  extends AzureMonitorExporterBase
  implements LogRecordExporter
{
  public constructor(options: AzureMonitorOptions) {
    super(new AzureMonitorExportClient(options));
  }

  public export(logs: ReadableLogRecord[], callback: (result: ExportResult) => void): void {
    this.client.export(
      logs.map((log) => logToEnvelope(log, this.client.instrumentationKey)),
      callback,
    );
  }
}
