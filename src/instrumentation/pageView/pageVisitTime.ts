// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { isValidTraceId } from "@opentelemetry/api";
import type { KeyValueStorage } from "../../storage/keyValueStorage.js";
import type { PageView } from "./types.js";

type Visit = Pick<PageView, "id" | "name" | "url" | "startTimeUnixMs">;

/** Instance-owned visit timer. Persistence bridges documents, never telemetry pipelines. */
export class PageVisitTime {
  #current: Visit | undefined;

  public constructor(
    private readonly storage: KeyValueStorage | null,
    private readonly key: string,
    private readonly report: (visit: Visit, duration: number) => void,
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
    const previous = this.#current ?? this.#read();
    this.#current = undefined;
    this.storage?.removeItem(this.key);
    // Commit the successor before reporting: re-entrant processors must not emit this twice.
    this.update(page);
    if (!previous || previous.id === page.id) return;
    const duration = page.startTimeUnixMs - previous.startTimeUnixMs;
    if (Number.isFinite(duration) && duration >= 0) this.report(previous, duration);
  }

  public update(page: PageView): void {
    this.#current = {
      id: page.id,
      name: page.name,
      url: page.url,
      startTimeUnixMs: page.startTimeUnixMs,
    };
    this.storage?.setItem(this.key, JSON.stringify(this.#current));
  }

  /** BFCache must resume from storage, not replay the old document's visit. */
  public suspend(): void {
    this.#current = undefined;
  }

  public stop(): void {
    if (this.#current?.id === this.#read()?.id) this.storage?.removeItem(this.key);
    this.#current = undefined;
  }
}
