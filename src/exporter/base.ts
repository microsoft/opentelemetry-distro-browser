// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { isUnloading } from "./common.js";
import { parseConnectionString } from "./connectionStringParser.js";
import { Sender, type SenderResultType } from "./sender.js";
import type { AzureMonitorEnvelope } from "./telemetryModels.js";

const CONTENT_TYPE = "application/json";

/**
 * Azure Monitor destination configuration.
 * @public
 */
export interface AzureMonitorOptions {
  readonly connectionString: string;
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
    if (!instrumentationKey) {
      throw new Error("The Azure Monitor connection string must contain an InstrumentationKey.");
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
      .send({ body, contentType: CONTENT_TYPE, unloading: isUnloading() })
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
  if (result.transport === "beacon" || (result.statusCode >= 200 && result.statusCode < 300)) {
    return { code: ExportResultCode.SUCCESS };
  }
  return {
    code: ExportResultCode.FAILED,
    error: new Error(`Azure Monitor ingestion failed with HTTP status ${result.statusCode}.`),
  };
}

export abstract class AzureMonitorExporterBase {
  protected constructor(protected readonly client: AzureMonitorExportClient) {}

  public forceFlush(): Promise<void> {
    return this.client.forceFlush();
  }

  public shutdown(): Promise<void> {
    return this.client.shutdown();
  }
}
