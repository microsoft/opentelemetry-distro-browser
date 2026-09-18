import { Attributes } from "@opentelemetry/api";
import type { LogRecordProcessor, ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Upstream applies session and document identity through paired processors so the same
 * attributes land on spans and log records. Timestamp proximity plus these attributes are the
 * correlation substitute for click-to-request parenting in the browser.
 */
export const SESSION_ID_ATTRIBUTE = "session.id";
export const DOCUMENT_URL_ATTRIBUTE = "browser.document.url.full";

export interface BrowserContextSource {
    sessionId: string;
    documentUrl(): string;
}

export function browserContextAttributes(source: BrowserContextSource): Attributes {
    return {
        [SESSION_ID_ATTRIBUTE]: source.sessionId,
        [DOCUMENT_URL_ATTRIBUTE]: source.documentUrl()
    };
}

export class BrowserContextSpanProcessor implements SpanProcessor {
    public constructor(private readonly source: BrowserContextSource) {
    }

    public onStart(span: Span): void {
        span.setAttributes(browserContextAttributes(this.source));
    }

    public onEnd(): void {
    }

    public forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    public shutdown(): Promise<void> {
        return Promise.resolve();
    }
}

export class BrowserContextLogRecordProcessor implements LogRecordProcessor {
    public constructor(private readonly source: BrowserContextSource) {
    }

    public onEmit(logRecord: ReadWriteLogRecord): void {
        logRecord.setAttributes(browserContextAttributes(this.source));
    }

    public forceFlush(): Promise<void> {
        return Promise.resolve();
    }

    public shutdown(): Promise<void> {
        return Promise.resolve();
    }
}
