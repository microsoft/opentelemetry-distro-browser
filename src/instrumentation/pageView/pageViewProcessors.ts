// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  DocumentLogRecordProcessor,
  DocumentSpanProcessor,
} from "@opentelemetry/browser-sdk/document";
import type { ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { pageViewAttributes } from "./pageViewAttributes.js";
import {
  ATTR_BROWSER_DOCUMENT_URL_FULL,
  ATTR_PAGE_VIEW_ID,
  EVENT_BROWSER_PAGE_VIEW,
} from "./semconv.js";
import type { PageView, PageViewSource } from "./types.js";

function canEnrich(
  record: Span | ReadWriteLogRecord,
  pageView: PageView | undefined,
): pageView is PageView {
  const id = record.attributes[ATTR_PAGE_VIEW_ID];
  // An explicit association with another page must never acquire this page's metadata.
  return pageView !== undefined && (id === undefined || id === pageView.id);
}

function enrich(record: Span | ReadWriteLogRecord, pageView: PageView): void {
  for (const [key, value] of Object.entries(pageViewAttributes(pageView))) {
    if (record.attributes[key] === undefined && value !== undefined) {
      record.setAttribute(key, value);
    }
  }
}

/** Captures the originating page, even when a span ends after navigation. */
export class PageViewSpanProcessor extends DocumentSpanProcessor {
  private pageView: PageView | undefined;

  constructor(private getPageView: PageViewSource["getCurrentPageView"] | undefined) {
    // The supported DocumentProvider reads the same sanitized snapshot as page enrichment.
    super({ getDocumentUrl: () => this.pageView?.url ?? null });
  }

  override onStart(...args: Parameters<DocumentSpanProcessor["onStart"]>): void {
    const pageView = (this.pageView = this.getPageView?.());
    const [span] = args;
    if (!canEnrich(span, pageView)) return;
    // Upstream supplies the URL; unlike its default behavior, preserve explicit values.
    if (span.attributes[ATTR_BROWSER_DOCUMENT_URL_FULL] === undefined) super.onStart(...args);
    enrich(span, pageView);
  }

  override shutdown(): Promise<void> {
    this.getPageView = undefined;
    this.pageView = undefined;
    return super.shutdown();
  }
}

/** Enriches accepted logs at emission without changing the pipeline's filtering. */
export class PageViewLogRecordProcessor extends DocumentLogRecordProcessor {
  private pageView: PageView | undefined;

  constructor(private getPageView: PageViewSource["getCurrentPageView"] | undefined) {
    super({ getDocumentUrl: () => this.pageView?.url ?? null });
  }

  enabled(): boolean {
    return false;
  }

  override onEmit(...args: Parameters<DocumentLogRecordProcessor["onEmit"]>): void {
    const [record] = args;
    // Page-view events already carry their own snapshot, possibly from an older navigation.
    if (record.eventName === EVENT_BROWSER_PAGE_VIEW) return;
    const pageView = (this.pageView = this.getPageView?.());
    if (!canEnrich(record, pageView)) return;
    if (record.attributes[ATTR_BROWSER_DOCUMENT_URL_FULL] === undefined) super.onEmit(...args);
    enrich(record, pageView);
  }

  override shutdown(): Promise<void> {
    this.getPageView = undefined;
    this.pageView = undefined;
    return super.shutdown();
  }
}
