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

type DropCodes = string | readonly string[];
type Entry = [
  time: number,
  body: string,
  dispatched?: boolean,
  onDrop?: () => void,
  codes?: DropCodes,
];

const pageListeners = new Set<() => void>();
let pageHidden = false;
const onPageTransition = (event: Event): void => {
  pageHidden = event.type === "pagehide";
  for (const listener of pageListeners) listener();
};

function subscribeToPageTransitions(listener: () => void): () => void {
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
 * Each record is `[released, [time, envelopes, dropCodes?], ...]` under a key unique to the destination,
 * document and exporter. A record is released only on `pagehide`, and only released records from
 * another document are adopted, so live same-origin frames, including hidden ones, never send each
 * other's telemetry. Adoption removes the record. Before each use, a page whose released record is
 * gone drops its copy, ignores later outcomes of requests started before the handoff and stops
 * their retries. Failed writes attempt to invalidate the record; if removal also fails, terminal
 * accounting waits until invalidation or handoff is confirmed.
 */
export class SessionBuffer {
  readonly #entries = new Map<number, Entry>();
  readonly #prefix: string;
  readonly #pagePrefix: string;
  readonly #key: string;
  readonly #storage: WebKeyValueStorage;
  readonly #unsubscribe: () => void;
  #nextId = 0;
  /** IDs with a request in progress that this document still owns. */
  readonly #live = new Set<number>();
  /** The stored record is marked released for adoption. */
  #released = false;
  #persisted = new Map<number, string>();
  readonly #outcomes = new Map<number, (() => void)[]>();
  #disposed = false;
  readonly #onExpired: ((body: string, codes: DropCodes) => void) | undefined;

  public constructor(
    destination: string,
    storage = createSessionBufferStorage(),
    onExpired?: (body: string, codes: DropCodes) => void,
  ) {
    this.#storage = storage;
    this.#onExpired = onExpired;
    // Encoded so a `|` in the endpoint cannot make one destination's prefix match another's keys.
    this.#prefix = `${SESSION_BUFFER_KEY_PREFIX}${encodeURIComponent(destination)}|`;
    this.#pagePrefix = `${this.#prefix}${globalThis.performance?.timeOrigin}|`;
    this.#key = `${this.#pagePrefix}${Math.random().toString(36).slice(2)}`;
    this.#unsubscribe = subscribeToPageTransitions(() => {
      this.#reconcile();
      this.#write();
    });
  }

  /** Marks a request in progress for a buffered ID, until {@link SessionBuffer.end}. */
  public begin(id: number): void {
    this.#live.add(id);
  }

  public end(id: number): void {
    this.#live.delete(id);
  }

  /**
   * Whether a request's batch still belongs to this document rather than one that adopted it or
   * a disposed exporter.
   */
  public owns(id: number): boolean {
    this.#reconcile();
    return this.#live.has(id);
  }

  /** Holds final outcomes while the persisted version still contains settled envelopes. */
  public account(id: number, onFinal: () => void): void {
    this.#reconcile();
    if (!this.#live.has(id)) return;
    if (!this.#hasStaleCopy(id)) onFinal();
    else {
      const callbacks = this.#outcomes.get(id) ?? [];
      callbacks.push(onFinal);
      this.#outcomes.set(id, callbacks);
    }
  }

  /** Transfers drop accounting until the persisted batch is invalidated or handed off. */
  public retain(id: number, onDrop: () => void, codes?: DropCodes): boolean {
    this.#reconcile();
    const entry = this.#entries.get(id);
    if (this.#persisted.has(id) && entry && !entry[2]) {
      entry[3] = onDrop;
      if (entry[4] !== codes) {
        entry[4] = codes;
        this.#write(true);
      }
      return true;
    }
    // A caller reporting a terminal drop must never have this batch restored by a later write.
    this.#entries.delete(id);
    return false;
  }

  /** Buffers a serialized envelope array and returns its ID. */
  public add(body: string, time = Date.now(), codes?: DropCodes): number {
    this.#reconcile();
    const id = this.#nextId++;
    this.#entries.set(id, [time, body, false, undefined, codes]);
    this.#write();
    return id;
  }

  /**
   * Leaves an unload request the browser accepted out of the record; it returns if the request
   * is later observed to fail.
   */
  public dispatch(id: number): void {
    const entry = this.owns(id) ? this.#entries.get(id) : undefined;
    if (!entry || entry[2]) return;
    entry[2] = true;
    this.#write();
  }

  /**
   * Keeps `body` for a buffered ID, replacing any earlier body, or removes it once delivered or
   * permanently rejected. Evicted, removed and handed-off IDs stay gone.
   */
  public settle(id: number, body: string, keep: boolean, codes?: DropCodes): void {
    const entry = this.owns(id) ? this.#entries.get(id) : undefined;
    if (!entry) return;
    const metadataOnly = keep && !entry[2] && entry[1] === body;
    if (metadataOnly) {
      if (codes === undefined || codes === entry[4]) return;
      entry[4] = codes;
    } else if (keep) this.#entries.set(id, [entry[0], body, false, undefined, codes]);
    else this.#entries.delete(id);
    this.#write(metadataOnly);
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
              (entry): entry is [number, unknown[], unknown?] =>
                Array.isArray(entry) &&
                typeof entry[0] === "number" &&
                Number.isFinite(entry[0]) &&
                Array.isArray(entry[1]) &&
                entry[1].length > 0,
            )
        : [];
      // Live records belong to another open document; leave them until they expire.
      if (!released && entries.some(([time]) => now - time <= MAX_SESSION_BUFFER_AGE_MS)) continue;
      if (!this.#invalidate(key) || !released) continue;
      for (const [time, envelopes, metadata] of entries) {
        const body = JSON.stringify(envelopes);
        const codes =
          typeof metadata === "string" ||
          (Array.isArray(metadata) &&
            metadata.length === envelopes.length &&
            metadata.every((code) => typeof code === "string"))
            ? metadata
            : undefined;
        if (now - time > MAX_SESSION_BUFFER_AGE_MS) {
          this.#onExpired?.(body, codes ?? "CLIENT_EXCEPTION");
          continue;
        }
        const id = this.#nextId++;
        this.#entries.set(id, [time, body, false, undefined, codes]);
        adopted.push([id, body]);
      }
    }
    if (adopted.length > 0) this.#write();
    return adopted;
  }

  /** Removes this exporter's record and stops tracking page transitions. */
  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#reconcile();
    const invalidated = !this.#persisted.size || this.#invalidate(this.#key) || !this.#released;
    if (invalidated) this.#persisted.clear();
    this.#commitOutcomes();
    this.#outcomes.clear();
    for (const id of this.#entries.keys()) {
      if (invalidated || !this.#persisted.has(id)) this.#drop(id);
    }
    this.#entries.clear();
    // Requests that settle later must not recreate the record.
    this.#live.clear();
  }

  #drop(id: number): void {
    const entry = this.#entries.get(id);
    this.#entries.delete(id);
    entry?.[3]?.();
  }

  #invalidate(key: string): boolean {
    return this.#storage.removeItem(key) || this.#storage.setItem(key, "[0]");
  }

  #hasStaleCopy(id: number): boolean {
    const stored = this.#persisted.get(id);
    const entry = this.#entries.get(id);
    return stored !== undefined && (entry?.[2] === true || stored !== entry?.[1]);
  }

  #commitOutcomes(): void {
    for (const [id, callbacks] of this.#outcomes) {
      if (this.#hasStaleCopy(id)) continue;
      this.#outcomes.delete(id);
      for (const callback of callbacks) callback();
    }
  }

  /**
   * Drops IDs handed off with this page's released snapshot. Dispatched requests stay owned only
   * when their stored copies were successfully invalidated before the handoff.
   */
  #reconcile(): void {
    if (!this.#released) return;
    const read = this.#storage.getItem(this.#key);
    if (!read.success || (read.value !== null && read.value !== "[0]")) return;
    for (const id of this.#persisted.keys()) {
      this.#entries.delete(id);
      this.#live.delete(id);
      this.#outcomes.delete(id);
    }
    this.#released = false;
    this.#persisted.clear();
  }

  #write(metadataOnly = false): void {
    const now = Date.now();
    const parts: [text: string, codes: DropCodes | undefined][] = [];
    const persisted = new Map<number, string>();
    const dropped: number[] = [];
    let length = 0;
    // Newest first, so the oldest batches are evicted even when adopted records interleave.
    const entries = [...this.#entries].sort(([, [left]], [, [right]]) => left - right).reverse();
    let full = false;
    for (const [id, [time, body, dispatched, , codes]] of entries) {
      if (dispatched) continue;
      const part = `[${time},${body}]`;
      // Once a batch overflows, it and every older batch are evicted. A batch that cannot fit
      // even alone is dropped without evicting older ones.
      if (
        full ||
        now - time > MAX_SESSION_BUFFER_AGE_MS ||
        part.length > MAX_SESSION_BUFFER_LENGTH ||
        (full = length + part.length > MAX_SESSION_BUFFER_LENGTH)
      ) {
        dropped.push(id);
        continue;
      }
      length += part.length + 1;
      parts.unshift([part, codes]);
      persisted.set(id, body);
    }
    // Optional accounting must not evict payloads that already fit.
    let hasMetadata = false;
    const serialized = parts.map(([part, codes]) => {
      if (codes === undefined) return part;
      const extra = `,${JSON.stringify(codes)}`;
      if (length + extra.length > MAX_SESSION_BUFFER_LENGTH) return part;
      length += extra.length;
      hasMetadata = true;
      return `${part.slice(0, -1)}${extra}]`;
    });
    const stored =
      parts.length > 0 &&
      this.#storage.setItem(
        this.#key,
        `[${pageHidden ? 1 : 0},${serialized.join(",")}]`,
        hasMetadata
          ? `[${pageHidden ? 1 : 0},${parts.map(([part]) => part).join(",")}]`
          : undefined,
        metadataOnly,
      );
    if (!stored && metadataOnly) return;
    // A failed write is not terminal while an older record may still be adopted.
    if (!stored && this.#persisted.size && !this.#invalidate(this.#key)) return;
    this.#released = stored && pageHidden;
    this.#persisted = stored ? persisted : new Map<number, string>();
    for (const id of dropped) this.#drop(id);
    if (!stored) {
      for (const [id, entry] of this.#entries) {
        if (entry[3]) this.#drop(id);
      }
    }
    this.#commitOutcomes();
  }
}
