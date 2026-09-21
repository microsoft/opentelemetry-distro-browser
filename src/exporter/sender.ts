// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  MAX_PENDING_KEEPALIVE_BODY_SIZE,
  MAX_PENDING_KEEPALIVE_REQUESTS,
  MAX_RETRY_AFTER_MS,
} from "./constants.js";

let pendingKeepaliveBodySize = 0;
let pendingKeepaliveRequestCount = 0;

export interface SenderOptions {
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxPayloadSize?: number;
}

export interface SendRequest {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly unloading?: boolean;
}

export interface SenderResult {
  readonly statusCode: number;
  readonly result: string;
  readonly retryAfterMs?: number;
}

export class Sender {
  private readonly endpoint: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly maxPayloadSize: number | undefined;

  public constructor(options: SenderOptions) {
    this.endpoint = options.endpoint;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxPayloadSize = options.maxPayloadSize;

    if (this.maxPayloadSize !== undefined && this.maxPayloadSize <= 0) {
      throw new RangeError("maxPayloadSize must be greater than zero.");
    }
  }

  public async send(request: SendRequest): Promise<SenderResult> {
    if (this.maxPayloadSize !== undefined && request.body.byteLength > this.maxPayloadSize) {
      throw new RangeError(
        `Payload size ${request.body.byteLength} exceeds the ${this.maxPayloadSize} byte limit.`,
      );
    }
    if (
      request.unloading &&
      (pendingKeepaliveBodySize + request.body.byteLength > MAX_PENDING_KEEPALIVE_BODY_SIZE ||
        pendingKeepaliveRequestCount >= MAX_PENDING_KEEPALIVE_REQUESTS)
    ) {
      throw new RangeError(
        `Unload payload cannot fit within the ${MAX_PENDING_KEEPALIVE_BODY_SIZE} byte and ${MAX_PENDING_KEEPALIVE_REQUESTS} request keepalive budget.`,
      );
    }

    const useKeepalive = request.unloading === true;
    if (useKeepalive) {
      pendingKeepaliveBodySize += request.body.byteLength;
      pendingKeepaliveRequestCount++;
    }

    try {
      const response = await this.fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": request.contentType },
        body: request.body,
        keepalive: useKeepalive,
      });

      const retryAfterMs = parseRetryAfterHeader(response.headers.get("retry-after"));
      return {
        statusCode: response.status,
        result: await response.text(),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      };
    } finally {
      if (useKeepalive) {
        pendingKeepaliveBodySize -= request.body.byteLength;
        pendingKeepaliveRequestCount--;
      }
    }
  }
}

function parseRetryAfterHeader(retryAfter: string | null): number | undefined {
  if (!retryAfter) {
    return undefined;
  }

  const trimmed = retryAfter.trim();
  if (/^\d+$/.test(trimmed)) {
    const delaySeconds = Number(trimmed);
    return delaySeconds > 0 ? Math.min(delaySeconds * 1000, MAX_RETRY_AFTER_MS) : undefined;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) {
    return undefined;
  }

  const delayMs = date - Date.now();
  return delayMs > 0 ? Math.min(delayMs, MAX_RETRY_AFTER_MS) : undefined;
}
