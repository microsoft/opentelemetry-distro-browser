// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { isSamplingRejection, parseBreezeResponse } from "./breezeUtils.js";
import { isUnloading } from "./common.js";
import { isValidInstrumentationKey, parseConnectionString } from "./connectionStringParser.js";
import { Sender, type SenderResultType } from "./sender.js";
import type { AzureMonitorEnvelope } from "./telemetryModels.js";

const CONTENT_TYPE = "application/json";

/**
 * Azure Monitor destination configuration.
 * @public
 */
export interface AzureMonitorOptions {
  /** Azure Monitor connection string containing a valid UUID instrumentation key. */
  readonly connectionString: string;
  /**
   * Disables `sendBeacon` fallback when a keepalive request cannot be queued during page unload.
   * This can prevent pending telemetry from being delivered when the page closes.
   */
  readonly disableBeacon?: boolean;
}

export class AzureMonitorExportClient {
  private readonly sender: Sender;
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;

  public constructor(options: AzureMonitorOptions) {
    const { instrumentationKey, ingestionEndpoint } = parseConnectionString(
      options.connectionString,
    );
    if (!instrumentationKey || !isValidInstrumentationKey(instrumentationKey)) {
      throw new Error(
        "The Azure Monitor connection string must contain a valid InstrumentationKey UUID.",
      );
    }
    this.instrumentationKey = instrumentationKey;
    this.sender = new Sender({
      endpoint: `${ingestionEndpoint}/v2/track`,
      disableBeacon: options.disableBeacon,
    });
  }

  public readonly instrumentationKey: string;

  public export(
    envelopes: readonly AzureMonitorEnvelope[],
    callback: (result: ExportResult) => void,
  ): void {
    if (this.stopped) {
      callback({ code: ExportResultCode.FAILED, error: new Error("Exporter has been shut down.") });
      return;
    }

    const body = new TextEncoder().encode(JSON.stringify(envelopes));
    const operation = this.sender
      .send({ body, contentType: CONTENT_TYPE, envelopes, unloading: isUnloading() })
      .then((result) => callback(toExportResult(result)))
      .catch((error: unknown) =>
        callback({
          code: ExportResultCode.FAILED,
          error: error instanceof Error ? error : new Error(String(error)),
        }),
      )
      .finally(() => this.pending.delete(operation));
    this.pending.add(operation);
  }

  public async forceFlush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  public async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.forceFlush();
  }
}

function toExportResult(result: SenderResultType): ExportResult {
  if (result.transport === "beacon") {
    return { code: ExportResultCode.SUCCESS };
  }
  if (result.statusCode >= 200 && result.statusCode < 300 && result.statusCode !== 206) {
    return { code: ExportResultCode.SUCCESS };
  }
  if (result.statusCode === 206) {
    const response = parseBreezeResponse(result.result);
    if (response && response.errors.every(isSamplingRejection)) {
      return { code: ExportResultCode.SUCCESS };
    }
  }
  return {
    code: ExportResultCode.FAILED,
    error: new Error(`Azure Monitor ingestion failed with HTTP status ${result.statusCode}.`),
  };
}
