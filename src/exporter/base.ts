// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import { isSamplingRejection, parseBreezeResponse } from "./breezeUtils.js";
import { isUnloading } from "./common.js";
import { isValidInstrumentationKey, parseConnectionString } from "./connectionStringParser.js";
import { MAX_BATCH_SIZE_IN_BYTES, MAX_PENDING_KEEPALIVE_BODY_SIZE } from "./constants.js";
import { Sender, type SenderResultType } from "./sender.js";
import type { AzureMonitorBaseData, AzureMonitorEnvelope } from "./telemetryModels.js";

const CONTENT_TYPE = "application/json";

/**
 * Azure Monitor destination configuration.
 * @public
 */
export interface AzureMonitorOptions {
  /**
   * Azure Monitor connection string containing a valid UUID instrumentation key.
   * Endpoints require HTTPS except on localhost or loopback IPs.
   * Invalid endpoints warn and fall back to suffix-derived or public cloud endpoints.
   */
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

    const unloading = isUnloading();
    let requests: ReturnType<typeof createBatchRequests>;
    try {
      requests = createBatchRequests(
        envelopes,
        unloading ? MAX_PENDING_KEEPALIVE_BODY_SIZE : MAX_BATCH_SIZE_IN_BYTES,
        unloading,
      );
    } catch (error) {
      callback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return;
    }
    const operation = Promise.allSettled(
      requests.map(({ body, envelopes: batchEnvelopes }) =>
        this.sender.send({
          body,
          contentType: CONTENT_TYPE,
          envelopes: batchEnvelopes,
          unloading,
        }),
      ),
    )
      .then((results) => {
        const fulfilled: SenderResultType[] = [];
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
          fulfilled.push(result.value);
        }
        return toExportResult(fulfilled);
      })
      .catch((error: unknown): ExportResult => ({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      }))
      // Callback errors must not be reported back to the same callback as export failures.
      .then(callback)
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

function createBatchRequests(
  envelopes: readonly AzureMonitorEnvelope[],
  maxBatchSize: number,
  enforceMaxBatchSize: boolean,
): Array<{
  body: Uint8Array<ArrayBuffer>;
  envelopes: readonly AzureMonitorEnvelope[];
}> {
  const encoder = new TextEncoder();
  if (enforceMaxBatchSize) {
    if (envelopes.length === 0) return [];
    const fitted = fitBatchCustomFields(envelopes, maxBatchSize, encoder);
    if (fitted.size > maxBatchSize) {
      throw new RangeError(
        `Unload payload size ${fitted.size} exceeds the ${maxBatchSize} byte aggregate keepalive limit.`,
      );
    }
    return [{ body: encoder.encode(fitted.serialized), envelopes: fitted.envelopes }];
  }

  const requests: Array<{
    body: Uint8Array<ArrayBuffer>;
    envelopes: readonly AzureMonitorEnvelope[];
  }> = [];
  let batch: AzureMonitorEnvelope[] = [];
  let serializedBatch: string[] = [];
  let batchSize = 2;

  const flush = (): void => {
    if (batch.length === 0) return;
    requests.push({
      body: encoder.encode(`[${serializedBatch.join(",")}]`),
      envelopes: batch,
    });
    batch = [];
    serializedBatch = [];
    batchSize = 2;
  };

  for (const envelope of envelopes) {
    // Normal exports treat maxBatchSize as a split threshold only. A single oversized envelope is
    // still sent on its own so ingestion can report a per-item failure; rejecting it locally would
    // hide that diagnostic.
    const separatorSize = batch.length === 0 ? 0 : 1;
    const { serialized, size: serializedSize } = serializeEnvelope(envelope, encoder);
    if (batch.length > 0 && batchSize + separatorSize + serializedSize > maxBatchSize) {
      flush();
    }
    batch.push(envelope);
    serializedBatch.push(serialized);
    batchSize += (batch.length === 1 ? 0 : 1) + serializedSize;
  }
  flush();
  return requests;
}

interface SerializedEnvelope {
  envelope: AzureMonitorEnvelope;
  serialized: string;
  size: number;
}

interface SerializedBatch {
  envelopes: readonly AzureMonitorEnvelope[];
  serialized: string;
  size: number;
}

function serializeEnvelope(
  envelope: AzureMonitorEnvelope,
  encoder: TextEncoder,
): SerializedEnvelope {
  const serialized = JSON.stringify(envelope);
  return { envelope, serialized, size: encoder.encode(serialized).byteLength };
}

function fitBatchCustomFields(
  envelopes: readonly AzureMonitorEnvelope[],
  maxBatchSize: number,
  encoder: TextEncoder,
): SerializedBatch {
  const serializeBatch = (batch: readonly AzureMonitorEnvelope[]): SerializedBatch => {
    const serialized = JSON.stringify(batch);
    return { envelopes: batch, serialized, size: encoder.encode(serialized).byteLength };
  };
  const original = serializeBatch(envelopes);
  if (original.size <= maxBatchSize) return original;

  const customFields: Array<{ size: number; remove: () => boolean }> = [];
  const createFittedEnvelopes = envelopes.map((envelope) => {
    const sourceBaseData = envelope.data.baseData;
    const properties = sourceBaseData.properties ? { ...sourceBaseData.properties } : undefined;
    const measurements = sourceBaseData.measurements
      ? { ...sourceBaseData.measurements }
      : undefined;
    const remaining = [
      properties ? Object.keys(properties).length : 0,
      measurements ? Object.keys(measurements).length : 0,
    ];
    [properties, measurements].forEach((fields, index) => {
      if (!fields) return;
      for (const key of Object.keys(fields)) {
        customFields.push({
          size: encoder.encode(JSON.stringify([key, fields[key]])).byteLength,
          remove: () => {
            delete fields[key];
            return --remaining[index] === 0;
          },
        });
      }
    });
    return (): AzureMonitorEnvelope => {
      const baseData: AzureMonitorBaseData = {
        ...sourceBaseData,
        properties: remaining[0] > 0 ? properties : undefined,
        measurements: remaining[1] > 0 ? measurements : undefined,
      };
      return { ...envelope, data: { ...envelope.data, baseData } };
    };
  });
  customFields.sort((left, right) => right.size - left.size);

  // Re-serialize only when the estimate might fit. Removing a defined `"key":value` entry and its
  // comma saves exactly the `["key",value]` size minus 1 byte (undefined values save nothing), so
  // the estimate never exceeds the real size and no fitting state is skipped. Emptying an object
  // also drops its wrapper, so that case is always measured. The estimate starts from the
  // normalized batch because empty containers are omitted there.
  const createBatch = (): AzureMonitorEnvelope[] =>
    createFittedEnvelopes.map((createEnvelope) => createEnvelope());
  let fitted = serializeBatch(createBatch());
  let estimatedSize = fitted.size;
  for (const field of customFields) {
    const emptied = field.remove();
    estimatedSize -= field.size - 1;
    if (!emptied && estimatedSize > maxBatchSize) continue;
    fitted = serializeBatch(createBatch());
    if (fitted.size <= maxBatchSize) return fitted;
    estimatedSize = fitted.size;
  }
  return fitted;
}

function toExportResult(results: readonly SenderResultType[]): ExportResult {
  for (const result of results) {
    const exportResult = toSingleExportResult(result);
    if (exportResult.code === ExportResultCode.FAILED) return exportResult;
  }
  return { code: ExportResultCode.SUCCESS };
}

function toSingleExportResult(result: SenderResultType): ExportResult {
  if (result.transport === "beacon") {
    return { code: ExportResultCode.SUCCESS };
  }
  if (result.permanentErrors?.length) {
    return {
      code: ExportResultCode.FAILED,
      error: new Error(
        `Azure Monitor ingestion permanently rejected ${result.permanentErrors.length} item(s).`,
      ),
    };
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
