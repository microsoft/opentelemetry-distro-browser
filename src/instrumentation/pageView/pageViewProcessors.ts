// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { PageViewSource } from "./types.js";

/** Correlates otherwise unparented logs, including when the trace pipeline is disabled. */
export class PageViewLogRecordProcessor implements LogRecordProcessor {
  constructor(private getPageView: PageViewSource["getCurrentPageView"] | undefined) {}

  enabled(): boolean {
    return false;
  }

  onEmit(record: ReadWriteLogRecord): void {
    // Explicit contexts, including delayed page-view snapshots, take precedence.
    if (!record.spanContext) {
      const spanContext = this.getPageView?.()?.spanContext;
      if (spanContext) record.spanContext = spanContext;
    }
  }

  async forceFlush(): Promise<void> {}

  shutdown(): Promise<void> {
    this.getPageView = undefined;
    return Promise.resolve();
  }
}
