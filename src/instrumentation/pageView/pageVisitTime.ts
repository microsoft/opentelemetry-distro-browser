// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isValidTraceId } from "@opentelemetry/api";
import type { KeyValueStorage } from "../../storage/keyValueStorage.js";
import type { PageView } from "./types.js";

type Visit = Pick<PageView, "id" | "name" | "url" | "startTimeUnixMs">;

function sameVisit(first: Visit | undefined, second: Visit | undefined): boolean {
  return !!first && first.id === second?.id && first.startTimeUnixMs === second.startTimeUnixMs;
}

/** Instance-owned visit timer. Persistence bridges documents, never telemetry pipelines. */
export class PageVisitTime {
  #current: Visit | undefined;
  #startup:
    { previous?: Visit; owner?: Visit; reports: { visit: Visit; duration: number }[] } | undefined;

  public constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly key: string,
    private readonly report: (visit: Visit, duration: number) => void,
    private readonly sanitizeRestoredUrl: (url: string) => string = (url) => url,
  ) {}

  #read(): Visit | undefined {
    const result = this.storage?.getItem(this.key);
    if (!result?.success || !result.value) return undefined;
    try {
      const value = JSON.parse(result.value) as Partial<Visit> | null;
      if (
        value &&
        typeof value.id === "string" &&
        isValidTraceId(value.id) &&
        typeof value.name === "string" &&
        typeof value.url === "string" &&
        typeof value.startTimeUnixMs === "number" &&
        Number.isFinite(value.startTimeUnixMs)
      )
        return value as Visit;
    } catch {
      // Web Storage is untrusted and may contain data from another application version.
    }
    return undefined;
  }

  public start(page: PageView): void {
    const restored = !this.#current;
    const previous = this.#current ?? this.#read();
    if (this.#startup && !this.#startup.owner) this.#startup.previous = previous;
    this.#current = undefined;
    this.storage?.removeItem(this.key);
    // Commit the successor before reporting: re-entrant processors must not emit this twice.
    this.update(page);
    if (!previous || sameVisit(previous, page)) return;
    const duration = page.startTimeUnixMs - previous.startTimeUnixMs;
    if (!Number.isFinite(duration) || duration < 0) return;
    const visit =
      restored && previous.url
        ? { ...previous, url: this.sanitizeRestoredUrl(previous.url) }
        : previous;
    if (this.#startup) this.#startup.reports.push({ visit, duration });
    else this.report(visit, duration);
  }

  public update(page: PageView): void {
    this.#current = {
      id: page.id,
      name: page.name,
      url: page.url,
      startTimeUnixMs: page.startTimeUnixMs,
    };
    if (this.#startup) this.#startup.owner = this.#current;
    this.storage?.setItem(this.key, JSON.stringify(this.#current));
  }

  /** Distribution startup opts in before collection; standalone reporting stays immediate. */
  public beginStartup(): void {
    this.#startup ??= { reports: [] };
  }

  public commitStartup(): void {
    const startup = this.#startup;
    // Clear before application callbacks can re-enter commit or rollback.
    this.#startup = undefined;
    for (const { visit, duration } of startup?.reports ?? []) this.report(visit, duration);
  }

  public rollbackStartup(): void {
    const startup = this.#startup;
    if (!startup) return;
    this.#startup = undefined;
    this.#current = undefined;
    // A later document or owner may have replaced our entry, even with the same trace ID.
    if (!startup.owner || !sameVisit(startup.owner, this.#read())) return;
    if (startup.previous) this.storage?.setItem(this.key, JSON.stringify(startup.previous));
    else this.storage?.removeItem(this.key);
  }

  /** BFCache must resume from storage, not replay the old document's visit. */
  public suspend(): void {
    this.#current = undefined;
  }

  public stop(): void {
    // An enable failure can trigger disable before the distribution reaches its catch block.
    if (this.#startup) {
      this.rollbackStartup();
      return;
    }
    if (this.#current && sameVisit(this.#current, this.#read())) this.storage?.removeItem(this.key);
    this.#current = undefined;
  }
}
