// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ExportResultCode } from "@opentelemetry/core";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureMonitorLogRecordExporter } from "../../../src/exporter/log.js";

const connectionString =
  "InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.test";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeLog(): ReadableLogRecord {
  return {
    hrTime: [1_735_689_600, 0],
    hrTimeObserved: [1_735_689_600, 0],
    body: "checkout completed",
    resource: { attributes: {} },
    instrumentationScope: { name: "test" },
    attributes: {},
    droppedAttributesCount: 0,
  } as unknown as ReadableLogRecord;
}

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
});
