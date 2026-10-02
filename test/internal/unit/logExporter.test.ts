// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExportResultCode } from "@opentelemetry/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureMonitorLogRecordExporter } from "../../../src/exporter/log.js";
import { createMockIngestionEndpoint } from "../../fixtures/azureMonitor.js";
import { createReadableLogRecord } from "../../fixtures/telemetry.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeLog(overrides: Partial<ReadableLogRecord> = {}): ReadableLogRecord {
  return {
    hrTime: [1_735_689_600, 0],
    hrTimeObserved: [1_735_689_600, 0],
    body: "checkout completed",
    resource: { attributes: {} },
    instrumentationScope: { name: "test" },
    attributes: {},
    droppedAttributesCount: 0,
    ...overrides,
  } as unknown as ReadableLogRecord;
}

>>>>>>> a0e9d5d (Export Azure Monitor page-view performance telemetry)
describe("AzureMonitorLogRecordExporter", () => {
  it("maps and exports log records", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const exporter = new AzureMonitorLogRecordExporter({ connectionString });

    const result = await new Promise<{ code: ExportResultCode }>((resolve) => {
      exporter.export([makeLog()], resolve);
    });

    expect(result).toEqual({ code: ExportResultCode.SUCCESS });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("exports page-view and performance envelopes from one log record", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const exporter = new AzureMonitorLogRecordExporter({ connectionString });
    const log = makeLog({
      eventName: "browser.page_view",
      attributes: {
        "browser.page_view.name": "Cart",
        "browser.page_view.performance.total": 170,
        "browser.page_view.performance.network_connect": 20,
        "browser.page_view.performance.sent_request": 50,
        "browser.page_view.performance.received_response": 30,
        "browser.page_view.performance.dom_processing": 70,
      },
    });

    const result = await new Promise<{ code: ExportResultCode }>((resolve) => {
      exporter.export([log], resolve);
    });

    expect(result).toEqual({ code: ExportResultCode.SUCCESS });
    const request = fetch.mock.calls[0]?.[1];
    const compressed = new Response(request?.body).body;
    const json = await new Response(
      compressed?.pipeThrough(new DecompressionStream("gzip")),
    ).text();
    const body = JSON.parse(json) as Array<{ data: { baseType: string } }>;
    expect(body.map((envelope) => envelope.data.baseType)).toEqual([
      "PageViewData",
      "PageViewPerformanceData",
    ]);
  });
});
