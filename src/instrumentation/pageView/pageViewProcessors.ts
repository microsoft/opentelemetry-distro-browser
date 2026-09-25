// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import { EVENT_BROWSER_PAGE_VIEW } from "./semconv.js";
import type { PageViewSource } from "./types.js";

/** Correlates otherwise unparented logs, including when the trace pipeline is disabled. */
export class PageViewLogRecordProcessor implements LogRecordProcessor {
  constructor(private getPageView: PageViewSource["getCurrentPageView"] | undefined) {}

  enabled(): boolean {
    return false;
  }

  onEmit(record: ReadWriteLogRecord): void {
    // Page views carry their originating context even when emission is delayed past navigation.
    if (!record.spanContext && record.eventName !== EVENT_BROWSER_PAGE_VIEW) {
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
