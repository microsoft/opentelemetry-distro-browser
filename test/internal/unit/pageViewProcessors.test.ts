// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace, type Attributes } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  DocumentLogRecordProcessor,
  DocumentSpanProcessor,
} from "@opentelemetry/browser-sdk/document";
import { afterEach, expect, it, vi } from "vitest";
import { useMicrosoftOpenTelemetry } from "../../../src/useMicrosoftOpenTelemetry.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/types.js";
import { PageViewInstrumentation } from "../../../src/instrumentation/pageView/pageViewInstrumentation.js";
import { createPageViewContext } from "../../../src/instrumentation/pageView/pageViewContext.js";
import {
  PageViewLogRecordProcessor,
  PageViewSpanProcessor,
} from "../../../src/instrumentation/pageView/pageViewProcessors.js";
import { EVENT_BROWSER_PAGE_VIEW } from "../../../src/instrumentation/pageView/semconv.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

const originalUrl = location.href;
const handles = new Set<MicrosoftOpenTelemetryBrowser>();

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
  history.replaceState(null, "", originalUrl);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

async function initialize(options: MicrosoftOpenTelemetryBrowserOptions = {}) {
  const pipeline = createInMemoryPipeline();
  const onStart = vi.spyOn(pipeline.spanProcessor, "onStart");
  const onEmit = vi.spyOn(pipeline.logProcessor, "onEmit");
  const handle = await useMicrosoftOpenTelemetry({ ...pipeline.options, ...options });
  handles.add(handle);
  const tracer = trace.getTracer("page-context");
  const logger = logs.getLogger("page-context");
  function emit(attributes: Attributes = {}) {
    tracer.startSpan("manual", { attributes }).end();
    logger.emit({ eventName: "manual", attributes });
    return [onStart.mock.calls.at(-1)![0], onEmit.mock.calls.at(-1)![0]] as const;
  }
  return { ...pipeline, onStart, onEmit, handle, tracer, logger, emit };
}

it("delegates document URL stamping and lifecycle to supported upstream processors", async () => {
  const onStart = vi.spyOn(DocumentSpanProcessor.prototype, "onStart");
  const onEmit = vi.spyOn(DocumentLogRecordProcessor.prototype, "onEmit");
  const spanShutdown = vi.spyOn(DocumentSpanProcessor.prototype, "shutdown");
  const logShutdown = vi.spyOn(DocumentLogRecordProcessor.prototype, "shutdown");
  const { emit, handle } = await initialize({
    pageView: { sanitizeUrl: () => "https://example.test/sanitized" },
  });
  for (const record of emit()) {
    expect(record.attributes["browser.document.url.full"]).toBe("https://example.test/sanitized");
  }
  expect(onStart).toHaveBeenCalledOnce();
  expect(onEmit).toHaveBeenCalledOnce();
  for (const attributes of [
    { "browser.document.url.full": "" },
    { "browser.document.url.full": "https://application.test/page" },
    { "browser.page_view.id": "different-page" },
  ])
    emit(attributes);
  expect(onStart).toHaveBeenCalledOnce();
  expect(onEmit).toHaveBeenCalledOnce();
  await handle.shutdown();
  expect(spanShutdown).toHaveBeenCalledOnce();
  expect(logShutdown).toHaveBeenCalledOnce();
});

it("shares sanitized initial and SPA context with both signals, without changing HTTP URLs", async () => {
  history.replaceState(null, "", "/initial?secret=one#private");
  vi.spyOn(document, "referrer", "get").mockReturnValue("https://referrer.example/?secret=two");
  const sanitizeUrl = vi.fn((raw: string) => {
    const url = new URL(raw);
    return url.origin + url.pathname;
  });
  const pipeline = await initialize({
    pageView: { sanitizeUrl, routeResolver: () => "/route/:id" },
  });
  const first = pipeline.emit({ "url.full": "https://api.example/orders/123" });
  const initialId = first[0].attributes["browser.page_view.id"];
  for (const record of first) {
    expect(record.attributes).toMatchObject({
      "browser.document.url.full": location.origin + "/initial",
      "browser.page_view.id": initialId,
      "browser.page_view.index": 0,
      "browser.page_view.name": "/route/:id",
      "browser.page_view.name_source": "route",
      "browser.page_view.referrer": "https://referrer.example/",
      "browser.page_view.same_document": false,
      "url.full": "https://api.example/orders/123",
    });
    expect(record.attributes["browser.page_view.type"]).toBeTypeOf("string");
  }
  window.dispatchEvent(new Event("pagehide"));
  const initialEvent = pipeline.onEmit.mock.calls.find(
    ([r]) => r.eventName === EVENT_BROWSER_PAGE_VIEW,
  )![0];
  expect(initialEvent.attributes["browser.page_view.id"]).toBe(initialId);
  expect(initialEvent.attributes["browser.document.url.full"]).toBe(location.origin + "/initial");

  const request = pipeline.tracer.startSpan("cross-navigation");
  const originatingAttributes = { ...pipeline.onStart.mock.calls.at(-1)![0].attributes };
  history.pushState(null, "", "/next?secret=three#private");
  const second = pipeline.emit();
  const nextId = second[0].attributes["browser.page_view.id"];
  expect(nextId).not.toBe(initialId);
  for (const record of second) {
    expect(record.attributes).toMatchObject({
      "browser.document.url.full": location.origin + "/next",
      "browser.page_view.id": nextId,
      "browser.page_view.index": 1,
      "browser.page_view.type": "push",
      "browser.page_view.same_document": true,
      "browser.page_view.referrer": location.origin + "/initial",
    });
    expect(record.attributes["url.full"]).toBeUndefined();
  }
  request.end();
  await pipeline.spanProcessor.forceFlush();
  expect(
    pipeline.spanExporter.getFinishedSpans().find((s) => s.name === "cross-navigation")?.attributes,
  ).toEqual(originatingAttributes);
  expect(originatingAttributes["browser.page_view.id"]).toBe(initialId);
  const sanitizations = sanitizeUrl.mock.calls.length;
  pipeline.emit();
  expect(sanitizeUrl).toHaveBeenCalledTimes(sanitizations);
});

it("preserves all explicit attributes, including empty strings, zero and false", async () => {
  const { emit } = await initialize();
  const id = emit()[0].attributes["browser.page_view.id"];
  const attributes = Object.freeze({
    "browser.page_view.id": id,
    "browser.document.url.full": "",
    "browser.page_view.index": 0,
    "browser.page_view.name": "",
    "browser.page_view.name_source": "explicit",
    "browser.page_view.type": "custom",
    "browser.page_view.same_document": false,
    "browser.page_view.referrer": "",
    "url.full": "https://api.example/",
  });
  for (const record of emit(attributes)) expect(record.attributes).toEqual(attributes);
  history.pushState(null, "", "/changed");
  // The old association also protects its metadata from the new current page.
  for (const record of emit(attributes)) expect(record.attributes).toEqual(attributes);
  for (const record of emit({ "browser.page_view.name": "custom-name" })) {
    expect(record.attributes["browser.page_view.name"]).toBe("custom-name");
    expect(record.attributes["browser.page_view.index"]).toBe(1);
  }
});

it.each(["external-page", ""])(
  "does not mix current context into an explicit page ID %j",
  async (id) => {
    const { emit } = await initialize();
    const attributes = { "browser.page_view.id": id };
    for (const record of emit(attributes)) expect(record.attributes).toEqual(attributes);
  },
);

it.each(["empty", "throw"])(
  "never falls back to raw URLs when sanitization returns %s",
  async (mode) => {
    vi.spyOn(document, "referrer", "get").mockReturnValue("https://referrer.example/private");
    const { emit, onEmit } = await initialize({
      pageView: {
        routeResolver: () => "/safe",
        sanitizeUrl: () => {
          if (mode === "throw") throw new Error("redaction failed");
          return "";
        },
      },
    });
    const records = [...emit()];
    window.dispatchEvent(new Event("pagehide"));
    records.push(onEmit.mock.calls.find(([r]) => r.eventName === EVENT_BROWSER_PAGE_VIEW)![0]);
    for (const record of records) {
      expect(record.attributes["browser.document.url.full"]).toBeUndefined();
      expect(record.attributes["browser.page_view.referrer"]).toBeUndefined();
      expect(record.attributes["url.full"]).toBeUndefined();
      expect(record.attributes["browser.page_view.name"]).toBe("/safe");
    }
  },
);

it.each([false, true])(
  "keeps a delayed page-view snapshot and hook edits (remove identity=%s)",
  async (removeIdentity) => {
    history.replaceState(null, "", "/old");
    vi.spyOn(document, "referrer", "get").mockReturnValue("");
    const { onEmit, emit } = await initialize({
      pageView: {
        applyCustomLogRecordData: (record) => {
          if (record.attributes?.["browser.page_view.index"] === 0) {
            if (removeIdentity) {
              delete record.attributes["browser.page_view.id"];
              delete record.attributes["browser.document.url.full"];
            }
            record.attributes["browser.page_view.name"] = "hook-name";
            history.pushState(null, "", "/new");
          }
        },
      },
    });
    window.dispatchEvent(new Event("pagehide"));
    const old = onEmit.mock.calls.find(([r]) => r.eventName === EVENT_BROWSER_PAGE_VIEW)![0];
    const current = emit()[1];
    expect(old.attributes["url.full"]).toBe(location.origin + "/old");
    expect(old.attributes["browser.document.url.full"]).toBe(
      removeIdentity ? undefined : location.origin + "/old",
    );
    expect(old.attributes["browser.page_view.id"]).not.toBe(
      current.attributes["browser.page_view.id"],
    );
    expect(old.attributes["browser.page_view.index"]).toBe(0);
    expect(old.attributes["browser.page_view.name"]).toBe("hook-name");
    expect(old.attributes["browser.page_view.referrer"]).toBeUndefined();
    expect(current.attributes["browser.document.url.full"]).toBe(location.origin + "/new");
    expect(current.attributes["browser.page_view.index"]).toBe(1);
  },
);

it("adds no page context when page views are disabled", async () => {
  const { emit } = await initialize({ pageView: { enabled: false } });
  history.pushState(null, "", "/disabled");
  for (const record of emit()) expect(record.attributes).toEqual({});
});

it("handles unavailable and cleared context and releases both processors on shutdown", async () => {
  const source = createPageViewContext();
  const getPageView = vi.fn(() => source.getCurrentPageView());
  const spanProcessor = new PageViewSpanProcessor(getPageView);
  const logProcessor = new PageViewLogRecordProcessor(getPageView);
  const pipeline = createInMemoryPipeline();
  const onStart = vi.spyOn(pipeline.spanProcessor, "onStart");
  const onEmit = vi.spyOn(pipeline.logProcessor, "onEmit");
  handles.add(
    await useMicrosoftOpenTelemetry({
      pageView: { enabled: false },
      spanProcessors: [spanProcessor, pipeline.spanProcessor],
      logRecordProcessors: [logProcessor, pipeline.logProcessor],
    }),
  );
  function emit() {
    trace.getTracer("source").startSpan("manual").end();
    logs.getLogger("source").emit({ eventName: "manual" });
    return [onStart.mock.calls.at(-1)![0].attributes, onEmit.mock.calls.at(-1)![0].attributes];
  }
  for (const attributes of emit()) expect(attributes).toEqual({});
  source.setCurrentPageView({
    id: "current",
    index: 0,
    name: "page",
    nameSource: "route",
    url: "https://example.test/",
    referrer: "",
    navigationType: "navigate",
    sameDocument: false,
    startTimeUnixMs: Date.now(),
  });
  getPageView.mockClear();
  for (const attributes of emit()) expect(attributes["browser.page_view.id"]).toBe("current");
  expect(getPageView).toHaveBeenCalledTimes(2);
  const current = source.getCurrentPageView()!;
  source.clear();
  for (const attributes of emit()) expect(attributes).toEqual({});
  source.setCurrentPageView({ ...current, id: "next" });
  await Promise.all([spanProcessor.forceFlush(), logProcessor.forceFlush()]);
  await Promise.all([spanProcessor.shutdown(), logProcessor.shutdown()]);
  getPageView.mockClear();
  for (const attributes of emit()) expect(attributes).toEqual({});
  expect(getPageView).not.toHaveBeenCalled();
  expect(logProcessor.enabled()).toBe(false);
});

it("stops stamping immediately on shutdown, even before provider shutdown finishes", async () => {
  const { handle, spanProcessor, onStart, tracer } = await initialize();
  const pushState = history.pushState;
  let finish!: () => void;
  const originalShutdown = spanProcessor.shutdown.bind(spanProcessor);
  vi.spyOn(spanProcessor, "shutdown").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          void originalShutdown().then(resolve);
        };
      }),
  );
  const stopping = handle.shutdown();
  try {
    expect(history.pushState).not.toBe(pushState);
    tracer.startSpan("stale").end();
    expect(onStart.mock.calls.at(-1)![0].attributes).toEqual({});
  } finally {
    finish();
    await stopping;
  }
});

it("clears context and restores history if page-view startup fails after enabling", async () => {
  const pushState = history.pushState;
  const originalEnable = PageViewInstrumentation.prototype.enable;
  let pageViews: PageViewInstrumentation["pageViews"] | undefined;
  vi.spyOn(PageViewInstrumentation.prototype, "enable").mockImplementation(function (
    this: PageViewInstrumentation,
  ) {
    pageViews = this.pageViews;
    originalEnable.call(this);
    throw new Error("page startup failed");
  });
  const pipeline = createInMemoryPipeline();
  const spanShutdown = vi.spyOn(pipeline.spanProcessor, "shutdown");
  const logShutdown = vi.spyOn(pipeline.logProcessor, "shutdown");
  await expect(useMicrosoftOpenTelemetry(pipeline.options)).rejects.toThrow("page startup failed");
  expect(history.pushState).toBe(pushState);
  expect(pageViews?.getCurrentPageView()).toBeUndefined();
  expect(spanShutdown).toHaveBeenCalledOnce();
  expect(logShutdown).toHaveBeenCalledOnce();
});
