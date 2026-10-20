// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createKeyValueStorage, type WebKeyValueStorage } from "../storage/keyValueStorage.js";

export const SESSION_BUFFER_KEY_PREFIX = "opentelemetry-buffer|";
/** Stored UTF-16 code units per exporter; oldest batches are evicted first. */
export const MAX_SESSION_BUFFER_LENGTH: number = 512 * 1024;
export const MAX_SESSION_BUFFER_AGE_MS: number = 60 * 60 * 1000;

/**
 * Buffer storage for exporter options created by `useMicrosoftOpenTelemetry`, keyed by the options
 * object. `null` disables buffering; absent options use unprefixed `sessionStorage`.
 */
export const sessionBufferStorage = new WeakMap<object, WebKeyValueStorage | null>();

export function createSessionBufferStorage(namePrefix?: string): WebKeyValueStorage {
  return createKeyValueStorage(
    "sessionStorage",
    "Unsent telemetry cannot be buffered in sessionStorage.",
    namePrefix,
  );
}

type Entry = [time: number, body: string];

const pageListeners = new Set<(event: PageTransitionEvent) => void>();
let pageHidden = false;
const onPageTransition = (event: Event): void => {
  pageHidden = event.type === "pagehide";
  for (const listener of pageListeners) listener(event as PageTransitionEvent);
};

function subscribeToPageTransitions(listener: (event: PageTransitionEvent) => void): () => void {
  if (pageListeners.size === 0) {
    pageHidden = false;
    globalThis.addEventListener?.("pagehide", onPageTransition);
    globalThis.addEventListener?.("pageshow", onPageTransition);
  }
  pageListeners.add(listener);
  return () => {
    if (!pageListeners.delete(listener) || pageListeners.size > 0) return;
    globalThis.removeEventListener?.("pagehide", onPageTransition);
    globalThis.removeEventListener?.("pageshow", onPageTransition);
  };
}

/**
 * Mirrors one exporter's unsent request bodies into a tab-scoped `sessionStorage` record so the
 * next page load in the same tab can send them.
 *
 * @remarks
 * Each record is `[released, [time, envelopes], ...]` under a key unique to the destination,
 * document and exporter. A record is released only on `pagehide`, and only released records from
 * another document are adopted, so live same-origin frames, including hidden ones, never send each
 * other's telemetry. Adoption removes the record; a page restored from the back/forward cache that
 * finds its record gone drops its copy and ignores later outcomes of requests started before the
 * handoff. Any failed write removes the record, so a stale copy cannot resend delivered telemetry.
 */
export class SessionBuffer {
  readonly #entries = new Map<number, Entry>();
  readonly #prefix: string;
  readonly #pagePrefix: string;
  readonly #key: string;
  readonly #storage: WebKeyValueStorage;
  readonly #unsubscribe: () => void;
  #nextId = 0;
  /** IDs below this were handed off to another document. */
  #firstOwnedId = 0;
  #stored = false;

  public constructor(destination: string, storage = createSessionBufferStorage()) {
    this.#storage = storage;
    this.#prefix = `${SESSION_BUFFER_KEY_PREFIX}${destination}|`;
    this.#pagePrefix = `${this.#prefix}${globalThis.performance?.timeOrigin}|`;
    this.#key = `${this.#pagePrefix}${Math.random().toString(36).slice(2)}`;
    this.#unsubscribe = subscribeToPageTransitions((event) => {
      if (event.type === "pageshow" && this.#stored) {
        const read = this.#storage.getItem(this.#key);
        if (read.success && read.value === null) {
          this.#entries.clear();
          this.#firstOwnedId = this.#nextId;
          this.#stored = false;
        }
      }
      this.#write();
    });
  }

  /** Buffers a serialized envelope array and returns its ID. */
  public add(body: string, time = Date.now()): number {
    const id = this.#nextId++;
    this.#entries.set(id, [time, body]);
    this.#write();
    return id;
  }

  /**
   * Keeps `body` for a buffered ID, replacing any earlier body, or removes it once delivered or
   * permanently rejected.
   */
  public settle(id: number, body: string, keep: boolean): void {
    const entry = this.#entries.get(id);
    if (id < this.#firstOwnedId || (keep ? entry?.[1] === body : !entry)) return;
    if (keep) this.#entries.set(id, [entry?.[0] ?? Date.now(), body]);
    else this.#entries.delete(id);
    this.#write();
  }

  /**
   * Takes ownership of released records left for this destination by earlier documents in the tab.
   * Expired and malformed records are discarded.
   */
  public adopt(): Array<[id: number, body: string]> {
    const adopted: Array<[number, string]> = [];
    const now = Date.now();
    for (const key of this.#storage.keys()) {
      if (!key.startsWith(this.#prefix) || key.startsWith(this.#pagePrefix)) continue;
      const read = this.#storage.getItem(key);
      if (!read.success) continue;
      let record: unknown;
      try {
        record = JSON.parse(read.value ?? "");
      } catch {
        // Malformed records are removed below.
      }
      const released = Array.isArray(record) && record[0] === 1;
      const entries = Array.isArray(record)
        ? record
            .slice(1)
            .filter(
              (entry): entry is [number, unknown[]] =>
                Array.isArray(entry) &&
                typeof entry[0] === "number" &&
                now - entry[0] <= MAX_SESSION_BUFFER_AGE_MS &&
                Array.isArray(entry[1]) &&
                entry[1].length > 0,
            )
        : [];
      // Live records belong to another open document; leave them until they expire.
      if (!released && entries.length > 0) continue;
      this.#storage.removeItem(key);
      if (!released) continue;
      for (const [time, envelopes] of entries) {
        const body = JSON.stringify(envelopes);
        const id = this.#nextId++;
        this.#entries.set(id, [time, body]);
        adopted.push([id, body]);
      }
    }
    if (adopted.length > 0) this.#write();
    return adopted;
  }

  /** Removes this exporter's record and stops tracking page transitions. */
  public dispose(): void {
    this.#unsubscribe();
    this.#entries.clear();
    this.#storage.removeItem(this.#key);
  }

  #write(): void {
    const now = Date.now();
    const parts: string[] = [];
    let length = 0;
    for (const [id, [time, body]] of [...this.#entries].reverse()) {
      const part = `[${time},${body}]`;
      if (
        now - time > MAX_SESSION_BUFFER_AGE_MS ||
        length + part.length > MAX_SESSION_BUFFER_LENGTH
      ) {
        this.#entries.delete(id);
        continue;
      }
      length += part.length + 1;
      parts.unshift(part);
    }
    if (parts.length === 0 && !this.#stored) return;
    this.#stored =
      parts.length > 0 &&
      this.#storage.setItem(this.#key, `[${pageHidden ? 1 : 0},${parts.join(",")}]`);
    if (!this.#stored) this.#storage.removeItem(this.#key);
  }
}
