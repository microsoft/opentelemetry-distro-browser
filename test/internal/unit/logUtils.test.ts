// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { SpanContext } from "@opentelemetry/api";
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs";
import { describe, expect, it } from "vitest";
import { logToEnvelope } from "../../../src/exporter/logUtils.js";

const instrumentationKey = "00000000-0000-0000-0000-000000000000";
const spanContext: SpanContext = {
  traceId: "0123456789abcdef0123456789abcdef",
  spanId: "0123456789abcdef",
  traceFlags: 1,
};
const resource = { attributes: { "service.name": "browser-store" } };

function makeLog(overrides: Partial<ReadableLogRecord> = {}): ReadableLogRecord {
  return {
    hrTime: [1_735_689_600, 0],
    hrTimeObserved: [1_735_689_600, 0],
    spanContext,
    resource,
    instrumentationScope: { name: "test" },
    attributes: {},
    droppedAttributesCount: 0,
    ...overrides,
  } as unknown as ReadableLogRecord;
}

describe("Azure Monitor log envelope mapping", () => {
  it("maps exception semantic attributes and severity", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "exception",
        severityNumber: 18,
        body: "request failed",
        attributes: {
          "exception.type": "TypeError",
          "exception.message": "Cannot read properties of undefined",
          "exception.stacktrace": "TypeError: Cannot read properties of undefined\n  at checkout",
          handled: false,
        },
      }),
      instrumentationKey,
    );

    expect(envelope.name).toBe("Microsoft.ApplicationInsights.Exception");
    expect(envelope.data).toEqual({
      baseType: "ExceptionData",
      baseData: {
        ver: 2,
        exceptions: [
          {
            typeName: "TypeError",
            message: "Cannot read properties of undefined",
            hasFullStack: true,
            stack: "TypeError: Cannot read properties of undefined\n  at checkout",
          },
        ],
        severityLevel: 3,
        properties: { handled: "false" },
        measurements: undefined,
      },
    });
  });

  it("maps an unnamed log to MessageData", () => {
    const envelope = logToEnvelope(
      makeLog({ body: "cart restored", severityNumber: 10, attributes: { itemCount: 3 } }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "MessageData",
      baseData: {
        ver: 2,
        message: "cart restored",
        severityLevel: 1,
        properties: undefined,
        measurements: { itemCount: 3 },
      },
    });
  });

  it("maps browser.navigation to PageViewData", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "browser.navigation",
        attributes: {
          "url.full": "https://shop.example.test/cart",
          "browser.navigation.duration": 425.25,
          "browser.navigation.same_document": true,
        },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "PageViewData",
      baseData: {
        ver: 2,
        name: "https://shop.example.test/cart",
        url: "https://shop.example.test/cart",
        duration: "00:00:00.425250",
        properties: { "browser.navigation.same_document": "true" },
        measurements: undefined,
      },
    });
  });

  it("maps other named logs to EventData", () => {
    const envelope = logToEnvelope(
      makeLog({
        eventName: "checkout.completed",
        attributes: { currency: "USD", total: 42.5, items: ["sku-1", "sku-2"] },
      }),
      instrumentationKey,
    );

    expect(envelope.data).toEqual({
      baseType: "EventData",
      baseData: {
        ver: 2,
        name: "checkout.completed",
        properties: { currency: "USD", items: '["sku-1","sku-2"]' },
        measurements: { total: 42.5 },
      },
    });
  });
});
