// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { AzureMonitorExportClient, type AzureMonitorOptions } from "./base.js";
import { logItemType, logToEnvelopes } from "./logUtils.js";
import { customerSdkStats } from "./customerSdkStats.js";

/**
 * Exports OpenTelemetry log records to Azure Monitor.
 *
 * @remarks
 * Synthetic page-operation contexts supply an operation ID, but not a parent ID.
 * Application and inherited span contexts retain their parent-ID mapping.
 * Built-in page-view diagnostics remain on OpenTelemetry records but are omitted from
 * Azure Monitor custom properties and measurements.
 *
 * @public
 */
export class AzureMonitorLogRecordExporter implements LogRecordExporter {
  readonly #client: AzureMonitorExportClient;

  /** Standalone export requires a resolved string; the distribution owns startup buffering. */
  public constructor(options: AzureMonitorOptions) {
    this.#client = new AzureMonitorExportClient(options);
    if (this.#client.itemStats) customerSdkStats.set(this, this.#client.itemStats);
  }

  public export(logs: ReadableLogRecord[], callback: (result: ExportResult) => void): void {
    this.#client.exportRecords(
      logs,
      (log) => logToEnvelopes(log, this.#client.instrumentationKey),
      logItemType,
      callback,
      this.#client.itemStats?.shouldCollectLog,
    );
  }

  public forceFlush(): Promise<void> {
    return this.#client.forceFlush();
  }

  public shutdown(): Promise<void> {
    return this.#client.shutdown();
  }
}
