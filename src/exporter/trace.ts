// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { AzureMonitorExportClient, type AzureMonitorOptions } from "./base.js";
import { isUnloading } from "./common.js";
import { spanToEnvelopes } from "./spanUtils.js";
import { customerSdkStats, spanItemType } from "./customerSdkStats.js";

/**
 * Exports OpenTelemetry spans to Azure Monitor.
 *
 * @remarks
 * Synthetic page-operation contexts supply an operation ID, but not a parent ID.
 * Application and inherited span contexts retain their parent-ID mapping.
 * Shutdown allows 30 seconds for application exports, then cancels outstanding sends before
 * disposing buffers and making the bounded final SDK Stats reports.
 *
 * @public
 */
export class AzureMonitorSpanExporter implements SpanExporter {
  readonly #client: AzureMonitorExportClient;

  /** Standalone export requires a resolved string; the distribution owns startup buffering. */
  public constructor(options: AzureMonitorOptions) {
    this.#client = new AzureMonitorExportClient(options);
    if (this.#client.itemStats) customerSdkStats.set(this, this.#client.itemStats);
  }

  public export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    const unloading = isUnloading();
    this.#client.exportRecords(
      spans,
      (span, preceding) =>
        spanToEnvelopes(span, this.#client.instrumentationKey, unloading ? preceding : undefined),
      (span) => spanItemType(span.kind),
      callback,
    );
  }

  public forceFlush(): Promise<void> {
    return this.#client.forceFlush();
  }

  public shutdown(): Promise<void> {
    return this.#client.shutdown();
  }
}
