// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { logs } from "@opentelemetry/api-logs";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useMicrosoftOpenTelemetry } from "../../../src/useMicrosoftOpenTelemetry.js";
import { EVENT_BROWSER_PAGE_VIEW } from "../../../src/instrumentation/pageView/semconv.js";
import type { MicrosoftOpenTelemetryBrowser } from "../../../src/types.js";

/** Captures every log record the distribution emits through the real pipeline. */
class RecordingProcessor implements LogRecordProcessor {
  public readonly eventNames: string[] = [];

  public onEmit(record: { eventName?: string }): void {
    if (record.eventName) {
      this.eventNames.push(record.eventName);
    }
  }

  public forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const originalUrl = location.href;
let sdk: MicrosoftOpenTelemetryBrowser | undefined;

/** Resolves after the browser has painted and the main thread has gone idle. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(resolve, 50);
      });
    });
  });
}

beforeEach(() => {
  history.replaceState(null, "", originalUrl);
});

afterEach(async () => {
  await sdk?.shutdown();
  sdk = undefined;
  logs.disable();
  history.replaceState(null, "", originalUrl);
});

describe("useMicrosoftOpenTelemetry instrumentation wiring", () => {
  it("emits page views through the distribution pipeline by default", async () => {
    const processor = new RecordingProcessor();
    sdk = useMicrosoftOpenTelemetry({ logRecordProcessors: [processor] });

    await settle();
    history.pushState(null, "", "/wired-route");
    await settle();

    expect(processor.eventNames.filter((name) => name === EVENT_BROWSER_PAGE_VIEW).length).toBe(2);
  });

  it("emits nothing when the page-view instrumentation is disabled", async () => {
    const processor = new RecordingProcessor();
    sdk = useMicrosoftOpenTelemetry({
      logRecordProcessors: [processor],
      instrumentationOptions: { pageView: { enabled: false } },
    });

    await settle();
    history.pushState(null, "", "/disabled-route");
    await settle();

    expect(processor.eventNames).not.toContain(EVENT_BROWSER_PAGE_VIEW);
  });

  it("stops observing after shutdown", async () => {
    const processor = new RecordingProcessor();
    sdk = useMicrosoftOpenTelemetry({ logRecordProcessors: [processor] });

    await settle();
    await sdk.shutdown();
    sdk = undefined;
    const afterShutdown = processor.eventNames.length;

    history.pushState(null, "", "/after-shutdown");
    await settle();

    expect(processor.eventNames.length).toBe(afterShutdown);
  });
});
