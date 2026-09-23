// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  MAX_BEACON_BODY_SIZE,
  MAX_PENDING_KEEPALIVE_BODY_SIZE,
  MAX_PENDING_KEEPALIVE_REQUESTS,
  MAX_RETRY_AFTER_MS,
} from "./constants.js";

let pendingKeepaliveBodySize = 0;
let pendingKeepaliveRequestCount = 0;

const trustedIngestionHostSuffixGroups = [
  [
    ".livediagnostics.monitor.azure.com",
    ".monitor.azure.com",
    ".services.visualstudio.com",
    ".applicationinsights.azure.com",
  ],
  [".monitor.azure.us", ".applicationinsights.azure.us"],
  [".monitor.azure.cn", ".applicationinsights.azure.cn"],
];

export interface SenderOptions {
  readonly endpoint: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sendBeacon?: typeof globalThis.navigator.sendBeacon;
  readonly disableBeacon?: boolean;
  readonly maxPayloadSize?: number;
}

export interface SendRequest {
  readonly body: Uint8Array<ArrayBuffer>;
  readonly contentType: string;
  readonly unloading?: boolean;
}

export interface SenderResult {
  readonly transport: "fetch";
  readonly statusCode: number;
  readonly result: string;
  readonly retryAfterMs?: number;
}

export interface BeaconSenderResult {
  readonly transport: "beacon";
}

export type SenderResultType = SenderResult | BeaconSenderResult;

export class Sender {
  private endpoint: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly sendBeacon: typeof globalThis.navigator.sendBeacon | undefined;
  private readonly disableBeacon: boolean;
  private readonly maxPayloadSize: number | undefined;

  public constructor(options: SenderOptions) {
    this.endpoint = options.endpoint;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.sendBeacon =
      options.sendBeacon ?? globalThis.navigator?.sendBeacon?.bind(globalThis.navigator);
    this.disableBeacon = options.disableBeacon ?? false;
    this.maxPayloadSize = options.maxPayloadSize;

    if (this.maxPayloadSize !== undefined && this.maxPayloadSize <= 0) {
      throw new RangeError("maxPayloadSize must be greater than zero.");
    }
  }

  public async send(request: SendRequest): Promise<SenderResultType> {
    if (this.maxPayloadSize !== undefined && request.body.byteLength > this.maxPayloadSize) {
      throw new RangeError(
        `Payload size ${request.body.byteLength} exceeds the ${this.maxPayloadSize} byte limit.`,
      );
    }
    const unloading = request.unloading === true;
    const keepaliveAvailable =
      pendingKeepaliveBodySize + request.body.byteLength <= MAX_PENDING_KEEPALIVE_BODY_SIZE &&
      pendingKeepaliveRequestCount < MAX_PENDING_KEEPALIVE_REQUESTS;
    if (unloading && !keepaliveAvailable) {
      return this.sendWithBeacon(request);
    }

    const useKeepalive = unloading;
    if (useKeepalive) {
      pendingKeepaliveBodySize += request.body.byteLength;
      pendingKeepaliveRequestCount++;
    }

    try {
      let response: Response;
      try {
        const payload = unloading ? undefined : await gzipPayload(request.body);
        response = await this.fetch(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": request.contentType,
            ...(payload === undefined ? {} : { "content-encoding": "gzip" }),
          },
          body: payload ?? request.body,
          keepalive: useKeepalive,
        });
      } catch (error) {
        if (unloading) {
          return this.sendWithBeacon(request, error);
        }
        throw error;
      }

      this.rememberRedirectEndpoint(response);
      const retryAfterMs = parseRetryAfterHeader(response.headers.get("retry-after"));
      return {
        transport: "fetch",
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

  private rememberRedirectEndpoint(response: Response): void {
    if (!response.redirected || response.url === this.endpoint) {
      return;
    }

    const redirectedEndpoint = getTrustedIngestionEndpoint(this.endpoint, response.url);
    if (redirectedEndpoint !== undefined) {
      this.endpoint = redirectedEndpoint;
    }
  }

  private sendWithBeacon(request: SendRequest, cause?: unknown): BeaconSenderResult {
    if (request.body.byteLength > MAX_BEACON_BODY_SIZE) {
      throw new RangeError(
        `Unload payload size ${request.body.byteLength} exceeds the ${MAX_BEACON_BODY_SIZE} byte beacon limit.`,
        { cause },
      );
    }

    if (this.disableBeacon || !this.sendBeacon) {
      throw new Error("sendBeacon fallback is unavailable for the unload request.", {
        cause,
      });
    }

    const body = new Blob([request.body], { type: "text/plain;charset=UTF-8" });
    if (!this.sendBeacon(this.endpoint, body)) {
      throw new Error("sendBeacon could not queue the unload request.", { cause });
    }

    return { transport: "beacon" };
  }
}

function getTrustedIngestionEndpoint(
  currentEndpoint: string,
  redirectedEndpoint: string,
): string | undefined {
  try {
    const currentUrl = new URL(currentEndpoint);
    const redirectedUrl = new URL(redirectedEndpoint);
    if (currentUrl.protocol !== "https:" || redirectedUrl.protocol !== "https:") {
      return undefined;
    }

    const currentHostname = normalizeHostname(currentUrl.hostname);
    const redirectedHostname = normalizeHostname(redirectedUrl.hostname);
    const currentPort = currentUrl.port || "443";
    const redirectedPort = redirectedUrl.port || "443";
    if (currentHostname === redirectedHostname) {
      return currentPort === redirectedPort ? redirectedUrl.toString() : undefined;
    }
    if (currentPort !== "443" || redirectedPort !== "443") {
      return undefined;
    }

    const sameCloud = trustedIngestionHostSuffixGroups.some(
      (suffixGroup) =>
        suffixGroup.some((suffix) => currentHostname.endsWith(suffix)) &&
        suffixGroup.some((suffix) => redirectedHostname.endsWith(suffix)),
    );
    return sameCloud ? redirectedUrl.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/, "");
}

async function gzipPayload(
  body: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (typeof globalThis.CompressionStream !== "function") {
    return undefined;
  }

  try {
    const stream = new Blob([body]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
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
