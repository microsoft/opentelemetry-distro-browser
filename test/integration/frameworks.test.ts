// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { ROOT_CONTEXT, context, trace } from "@opentelemetry/api";
import { createMemoryHistory } from "history";
import { StrictMode, createElement, useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupFrameworks,
  loadFrameworks,
  mountReact,
  startFrameworkTelemetry,
} from "../fixtures/frameworks.js";

let frameworks: Awaited<ReturnType<typeof loadFrameworks>>;
let originalTitle: string;

beforeEach(async () => {
  originalTitle = document.title;
  document.title = "Framework integration";
  frameworks = await loadFrameworks();
});

afterEach(async () => {
  try {
    await cleanupFrameworks();
  } finally {
    document.title = originalTitle;
  }
});

describe("built React integration", () => {
  it.each(["v4", "v5"] as const)(
    "tracks one view per memory-history route (%s)",
    async (version) => {
      const history = createMemoryHistory({ initialEntries: ["/home"] });
      const listen = vi.spyOn(history, "listen");
      const browserUrl = location.href;
      const pushState = window.history.pushState;
      const replaceState = window.history.replaceState;
      type HistorySource = NonNullable<
        ConstructorParameters<typeof frameworks.react.ReactPlugin>[0]
      >["history"];
      // Both contracts are driven by a real memory history; v4 supplies two listener arguments.
      const source: HistorySource =
        version === "v4"
          ? {
              get location() {
                return history.location;
              },
              listen(listener) {
                return history.listen(({ location, action }) => listener(location, action));
              },
            }
          : history;
      const plugin = new frameworks.react.ReactPlugin({ history: source });
      expect(listen).not.toHaveBeenCalled();
      const fixture = await startFrameworkTelemetry(plugin);
      const app = mountReact(
        createElement("button", { onClick: () => history.push("/orders/42") }, "Navigate"),
      );
      const [initial] = await fixture.waitForPages(1);
      expect(initial.attributes).toMatchObject({
        "browser.page_view.index": 0,
        "browser.page_view.name": "Framework integration",
        "browser.page_view.name_source": "document_title",
        "browser.page_view.same_document": false,
        "url.full": `${location.origin}/home`,
      });
      document.title = "Order details";
      app.host.querySelector("button")!.click();
      const [, route] = await fixture.waitForPages(2);
      expect(route.attributes).toMatchObject({
        "browser.page_view.index": 1,
        "browser.page_view.name": "Order details",
        "browser.page_view.name_source": "document_title",
        "browser.page_view.same_document": true,
        "browser.page_view.type": "push",
        "url.full": `${location.origin}/orders/42`,
      });
      history.push("/orders/42");
      history.replace("/orders/43");
      await fixture.waitForPages(3);
      history.back();
      await fixture.waitForPages(4);
      expect(
        fixture
          .pages()
          .map((page) => page.attributes["browser.page_view.type"])
          .slice(1),
      ).toEqual(["push", "replace", "traverse"]);
      expect(listen).toHaveBeenCalledTimes(1);
      expect(location.href).toBe(browserUrl);
      expect(window.history.pushState).toBe(pushState);
      expect(window.history.replaceState).toBe(replaceState);
    },
  );

  it("tracks query-only and hash-only routes before redaction with fresh operations", async () => {
    const history = createMemoryHistory({
      initialEntries: ["/orders/42?token=first#token=first"],
    });
    const plugin = new frameworks.react.ReactPlugin({ history });
    const source = plugin.pageView.routeSource!;
    const fixture = await startFrameworkTelemetry(plugin);
    const [initial] = await fixture.waitForPages(1);
    const redacted = `${location.origin}/orders/42?token=REDACTED#token=REDACTED`;
    expect(initial.attributes["url.full"]).toBe(redacted);
    let previousOperation = initial.attributes["browser.page_view.id"];
    for (const [index, url] of [
      "/orders/42?token=second#token=first",
      "/orders/42?token=second#token=second",
    ].entries()) {
      history.push(url);
      expect(source.getCurrentUrl()).toBe(url);
      const operation = trace.getSpanContext(context.active())?.traceId;
      expect(operation).toEqual(expect.any(String));
      expect(operation).not.toBe(previousOperation);
      const pages = await fixture.waitForPages(index + 2);
      expect(pages[index + 1].attributes).toMatchObject({
        "browser.page_view.index": index + 1,
        "browser.page_view.id": operation,
        "browser.page_view.same_document": true,
        "browser.page_view.type": "push",
        "browser.page_view.referrer": redacted,
        "url.full": redacted,
      });
      previousOperation = operation;
    }
  });

  it("unsubscribes while disabled and freezes the route and operation until navigation resumes", async () => {
    const history = createMemoryHistory({ initialEntries: ["/home?tab=first#summary"] });
    let callbackTraceId: string | undefined;
    const stop = history.listen(() => {
      callbackTraceId = trace.getSpanContext(context.active())?.traceId;
    });
    const originalListen = history.listen.bind(history);
    const unlisten = vi.fn();
    const listen = vi.spyOn(history, "listen").mockImplementation((listener) => {
      const stop = originalListen(listener);
      return () => {
        unlisten();
        stop();
      };
    });
    const plugin = new frameworks.react.ReactPlugin({ history });
    const source = plugin.pageView.routeSource!;
    const fixture = await startFrameworkTelemetry(plugin);
    const [initial] = await fixture.waitForPages(1);
    const operation = initial.attributes["browser.page_view.id"];
    expect(trace.getSpanContext(context.active())?.traceId).toBe(operation);
    plugin.disable();
    expect(unlisten).toHaveBeenCalledTimes(1);
    history.push("/orders/1?token=paused#details");
    expect(source.getCurrentUrl()).toBe("/home?tab=first#summary");
    expect(trace.getSpanContext(context.active())?.traceId).toBe(operation);
    trace.getTracer("framework-test").startSpan("while paused").end();
    await fixture.telemetry.forceFlush();
    expect(fixture.pages()).toHaveLength(1);
    expect(fixture.spanExporter.getFinishedSpans()[0].spanContext().traceId).toBe(operation);
    plugin.enable();
    expect(listen).toHaveBeenCalledTimes(2);
    expect(source.getCurrentUrl()).toBe("/home?tab=first#summary");
    expect(trace.getSpanContext(context.active())?.traceId).toBe(operation);
    history.go(0);
    expect(callbackTraceId).toBe(operation);
    expect(source.getCurrentUrl()).toBe("/home?tab=first#summary");
    trace.getTracer("framework-test").startSpan("after enable before nav").end();
    await fixture.telemetry.forceFlush();
    expect(fixture.pages()).toHaveLength(1);
    expect(
      fixture.spanExporter
        .getFinishedSpans()
        .map((span) => span.name)
        .slice(-1)[0],
    ).toBe("after enable before nav");
    expect(
      fixture.spanExporter
        .getFinishedSpans()
        .map((span) => span.spanContext().traceId)
        .slice(-1)[0],
    ).toBe(operation);
    // A new commit to the same URL reached while paused must still be observed.
    history.push("/orders/1?token=paused#details");
    stop();
    const [, resumed] = await fixture.waitForPages(2);
    expect(resumed.attributes).toMatchObject({
      "browser.page_view.index": 1,
      "browser.page_view.referrer": `${location.origin}/home?tab=first#summary`,
      "url.full": `${location.origin}/orders/1?token=REDACTED#details`,
    });
    expect(resumed.attributes["browser.page_view.id"]).not.toBe(operation);
    expect(callbackTraceId).toBe(resumed.attributes["browser.page_view.id"]);
    expect(trace.getSpanContext(context.active())?.traceId).toBe(
      resumed.attributes["browser.page_view.id"],
    );
  });

  it("correlates routed callbacks while preserving explicit span context", async () => {
    const history = createMemoryHistory();
    const stop = history.listen(() => {
      trace.getTracer("framework-test").startSpan("earlier history listener").end();
    });
    const plugin = new frameworks.react.ReactPlugin({
      history,
      routeResolver: () => "/orders/:id",
    });
    const fixture = await startFrameworkTelemetry(plugin);
    const [initial] = await fixture.waitForPages(1);
    let callbackTraceId: string | undefined;
    function Button() {
      const current = frameworks.react.useAppInsightsContext();
      return createElement(
        "button",
        {
          onClick: () => {
            history.push("/orders/42");
            callbackTraceId = trace.getSpanContext(context.active())?.traceId;
            current.trackEvent({ name: "order.opened" });
            const span = trace.getTracer("framework-test").startSpan("order.load");
            context.with(trace.setSpan(ROOT_CONTEXT, span), () => {
              current.trackTrace({ message: "explicit child" });
            });
            span.end();
          },
        },
        "Open",
      );
    }
    const app = mountReact(
      createElement(
        frameworks.react.AppInsightsContext.Provider,
        { value: plugin },
        createElement(Button),
      ),
    );
    app.host.querySelector("button")!.click();
    stop();
    const [, page] = await fixture.waitForPages(2);
    expect(page.attributes).toMatchObject({
      "browser.page_view.name": "/orders/:id",
      "browser.page_view.name_source": "route",
    });
    const event = fixture.records().find((record) => record.eventName === "order.opened")!;
    const spans = fixture.spanExporter.getFinishedSpans();
    const span = spans.find((span) => span.name === "order.load")!;
    expect(
      spans.find((span) => span.name === "earlier history listener")?.spanContext().traceId,
    ).toBe(page.attributes["browser.page_view.id"]);
    expect(callbackTraceId).toBe(page.attributes["browser.page_view.id"]);
    expect(event.spanContext?.traceId).toBe(callbackTraceId);
    expect(span.spanContext().traceId).toBe(callbackTraceId);
    expect(
      fixture.records().find((record) => record.body === "explicit child")?.spanContext,
    ).toEqual(span.spanContext());
    expect(initial.spanContext?.traceId).not.toBe(callbackTraceId);
  });

  it("exports valid React tracking records", async () => {
    const plugin = new frameworks.react.ReactPlugin();
    const fixture = await startFrameworkTelemetry(plugin, { enabled: false });
    expect(plugin.getAppInsights()).toBe(plugin);
    expect(plugin.getConfig()).toEqual({ enabled: true });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    plugin.trackEvent(
      { name: "checkout", properties: { source: "original" } },
      {
        source: "override",
        count: 2,
        valid: true,
        nested: { ok: true },
        absent: undefined,
        cyclic,
      },
    );
    plugin.trackMetric({ name: "cart", average: 3, sampleCount: 2, min: 1, max: 5, stdDev: 2 });
    plugin.trackMetric({ name: "invalid", average: NaN });
    plugin.trackMetric({ name: "invalid", average: Infinity });
    for (const name of ["", " \t\n"]) {
      plugin.trackMetric({ name, average: 1 });
    }
    for (const sampleCount of [0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      plugin.trackMetric({ name: "invalid count", average: 1, sampleCount });
    }
    plugin.trackTrace({ message: "warning", severityLevel: 2, properties: { route: "checkout" } });
    const error = new TypeError("payment failed");
    plugin.trackException({ exception: error, severityLevel: 4 });
    plugin.trackPageView({
      name: "Manual",
      uri: "https://user:secret@example.test/cart?token=private",
      duration: 12,
    });
    await fixture.telemetry.forceFlush();
    expect(fixture.records()).toHaveLength(5);
    const [event, metric, message, exception, page] = fixture.records();
    expect(event.attributes).toEqual({
      source: "override",
      count: 2,
      valid: true,
      nested: '{"ok":true}',
    });
    expect(metric.attributes).toMatchObject({
      "metric.name": "cart",
      "metric.value": 3,
      "metric.count": 2,
      "metric.min": 1,
      "metric.max": 5,
      "metric.stddev": 2,
    });
    expect(message).toMatchObject({
      body: "warning",
      severityNumber: 13,
      attributes: { route: "checkout" },
    });
    expect(exception).toMatchObject({
      severityNumber: 21,
      attributes: {
        "exception.type": "TypeError",
        "exception.message": "payment failed",
        "exception.stacktrace": error.stack,
      },
    });
    expect(page.attributes).toMatchObject({
      "browser.page_view.name": "Manual",
      "browser.page_view.duration": 12,
      "url.full": "https://REDACTED:REDACTED@example.test/cart?token=REDACTED",
    });
  });

  it("applies the owning React URL sanitizer without reserved-property bypasses", async () => {
    const plugin = new frameworks.react.ReactPlugin();
    const sanitizeUrl = vi.fn((url: string) => new URL(url).pathname.replace("/42", "/:id"));
    const fixture = await startFrameworkTelemetry(
      plugin,
      { enabled: false, sanitizeUrl },
      { redactQueryParams: ["customerId"] },
    );
    const uri =
      "https://user:secret@example.test/orders/42?customerId=customer-private&token=token-private#customerId=fragment-private";
    const properties = {
      "url.full": "unsafe",
      "browser.page_view.referrer": "unsafe",
      source: "manual",
    };
    plugin.trackPageView({ name: "Sanitized", uri, properties });
    expect(sanitizeUrl).toHaveBeenCalledExactlyOnceWith(
      "https://REDACTED:REDACTED@example.test/orders/42?customerId=REDACTED&token=REDACTED#customerId=REDACTED",
    );
    plugin.trackPageView({ name: "No URI", properties });
    sanitizeUrl.mockImplementationOnce(() => {
      throw new Error("sanitization failed");
    });
    expect(() => plugin.trackPageView({ name: "Failed sanitizer", uri, properties })).not.toThrow();
    await fixture.telemetry.forceFlush();
    expect(fixture.pages()).toHaveLength(3);
    expect(fixture.pages()[0].attributes).toMatchObject({
      "browser.page_view.name": "Sanitized",
      "url.full": "/orders/:id",
      source: "manual",
    });
    expect(fixture.pages()[0].attributes["browser.page_view.referrer"]).toBeUndefined();
    for (const page of fixture.pages().slice(1)) {
      expect(page.attributes).toMatchObject({ source: "manual" });
      expect(page.attributes["url.full"]).toBeUndefined();
      expect(page.attributes["browser.page_view.referrer"]).toBeUndefined();
    }
  });

  it("keeps manual React page views and privacy policies bound to their instances", async () => {
    const first = new frameworks.react.ReactPlugin();
    const second = new frameworks.react.ReactPlugin();
    const a = await startFrameworkTelemetry(
      first,
      { enabled: false },
      { redactQueryParams: ["customerId"] },
    );
    const b = await startFrameworkTelemetry(
      second,
      {
        enabled: false,
        sanitizeUrl: (url) => {
          const parsed = new URL(url);
          return parsed.pathname + parsed.search;
        },
      },
      { redactQueryParams: ["accountId"] },
    );
    const uri =
      "https://example.test/orders/42?customerId=customer-42&accountId=account-7&token=private";
    first.trackPageView({ name: "First", uri });
    second.trackPageView({ name: "Second", uri });
    await Promise.all([a.telemetry.forceFlush(), b.telemetry.forceFlush()]);
    expect(a.records()).toHaveLength(1);
    expect(b.records()).toHaveLength(1);
    expect(a.pages()[0].attributes).toMatchObject({
      "browser.page_view.name": "First",
      "url.full":
        "https://example.test/orders/42?customerId=REDACTED&accountId=account-7&token=REDACTED",
    });
    expect(b.pages()[0].attributes).toMatchObject({
      "browser.page_view.name": "Second",
      "url.full": "/orders/42?customerId=customer-42&accountId=REDACTED&token=REDACTED",
    });
  });

  it("tracks committed state, not initializer changes or same-value updates, in StrictMode", async () => {
    const plugin = new frameworks.react.ReactPlugin();
    const fixture = await startFrameworkTelemetry(plugin, { enabled: false });
    let update!: ReturnType<typeof frameworks.react.useTrackEvent<number>>;
    function EventComponent({ initial, name }: { initial: number; name: string }) {
      update = frameworks.react.useTrackEvent(plugin, name, initial);
      return null;
    }
    const view = (initial: number, name = "count") =>
      createElement(StrictMode, null, createElement(EventComponent, { initial, name }));
    const app = mountReact(view(1));
    await fixture.telemetry.forceFlush();
    expect(fixture.records()).toHaveLength(0);
    app.render(view(99));
    update((value) => value + 1);
    await expect
      .poll(async () => {
        await fixture.telemetry.forceFlush();
        return fixture.records().length;
      })
      .toBe(1);
    expect(fixture.records()[0]).toMatchObject({ eventName: "count", attributes: { data: 2 } });
    update(2);
    await fixture.telemetry.forceFlush();
    expect(fixture.records()).toHaveLength(1);
    app.render(view(99, "renamed"));
    await fixture.telemetry.forceFlush();
    expect(fixture.records().map((record) => [record.eventName, record.attributes.data])).toEqual([
      ["count", 2],
      ["renamed", 2],
    ]);
  });

  it("reports opt-in initial object events once and rebinds to the latest plugin", async () => {
    const first = new frameworks.react.ReactPlugin();
    const second = new frameworks.react.ReactPlugin();
    const a = await startFrameworkTelemetry(first, { enabled: false });
    const b = await startFrameworkTelemetry(second, { enabled: false });
    function EventComponent({ plugin }: { plugin: typeof first }) {
      frameworks.react.useTrackEvent(plugin, "selection", { id: 42 }, false);
      return null;
    }
    const view = (plugin: typeof first) =>
      createElement(StrictMode, null, createElement(EventComponent, { plugin }));
    const app = mountReact(view(first));
    app.render(view(second));
    await Promise.all([a.telemetry.forceFlush(), b.telemetry.forceFlush()]);
    expect(a.records()).toHaveLength(1);
    expect(b.records()).toHaveLength(1);
    for (const fixture of [a, b]) {
      expect(fixture.records()[0]).toMatchObject({
        eventName: "selection",
        attributes: { id: 42 },
      });
    }
  });

  it("uses the nearest context and catches missing-provider errors in the error boundary", async () => {
    const plugin = new frameworks.react.ReactPlugin();
    const other = new frameworks.react.ReactPlugin();
    const fixture = await startFrameworkTelemetry(plugin, { enabled: false });
    const otherFixture = await startFrameworkTelemetry(other, { enabled: false });
    function Consumer() {
      const selected = frameworks.react.useAppInsightsContext();
      useEffect(() => selected.trackEvent({ name: "context.selected" }), [selected]);
      return null;
    }
    const app = mountReact(
      createElement(
        frameworks.react.AppInsightsContext.Provider,
        { value: plugin },
        createElement(
          frameworks.react.AppInsightsContext.Provider,
          { value: other },
          createElement(Consumer),
        ),
      ),
    );
    await Promise.all([fixture.telemetry.forceFlush(), otherFixture.telemetry.forceFlush()]);
    expect(fixture.records()).toHaveLength(0);
    expect(otherFixture.records()).toHaveLength(1);
    function Fallback({
      error,
      errorInfo,
    }: {
      error: Error | null;
      errorInfo: { componentStack?: string | null } | null;
    }) {
      return createElement("p", null, `${error?.message} ${errorInfo?.componentStack ?? ""}`);
    }
    app.render(
      createElement(frameworks.react.AppInsightsErrorBoundary, {
        appInsights: plugin,
        onError: Fallback,
        children: createElement(Consumer),
      }),
    );
    await expect
      .poll(() => app.host.textContent)
      .toContain("requires an AppInsightsContext provider");
    await fixture.telemetry.forceFlush();
    expect(fixture.records()).toHaveLength(1);
    expect(fixture.records()[0]).toMatchObject({
      eventName: "exception",
      severityNumber: 17,
      attributes: {
        "exception.message": "useAppInsightsContext requires an AppInsightsContext provider.",
        componentStack: expect.stringContaining("Consumer"),
      },
    });
  });

  it("excludes idle gaps and emits engagement on real unmount with the latest props", async () => {
    const plugin = new frameworks.react.ReactPlugin();
    const fixture = await startFrameworkTelemetry(plugin, { enabled: false });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let activity!: () => void;
    function Engaged({ name }: { name: string }) {
      activity = frameworks.react.useTrackMetric(plugin, name, { version: name });
      return createElement("button", { onClick: activity }, name);
    }
    const view = (name: string) =>
      createElement(StrictMode, null, createElement(Engaged, { name }));
    const app = mountReact(view("First"));
    app.host.querySelector("button")!.click();
    now = 1000;
    activity();
    now = 7000;
    activity();
    app.render(view("Latest"));
    await fixture.telemetry.forceFlush();
    expect(fixture.records()).toHaveLength(0);
    now = 7500;
    app.unmount();
    await Promise.resolve();
    activity();
    await fixture.telemetry.forceFlush();
    expect(fixture.records()).toHaveLength(1);
    expect(fixture.records()[0].attributes).toMatchObject({
      "metric.name": "React Component Engaged Time (seconds)",
      "metric.value": 1.5,
      "metric.count": 1,
      "Component Name": "Latest",
      version: "Latest",
    });
  });

  it("does not report engagement for untouched components or StrictMode replay", async () => {
    const plugin = new frameworks.react.ReactPlugin();
    const fixture = await startFrameworkTelemetry(plugin, { enabled: false });
    function Untouched() {
      frameworks.react.useTrackMetric(plugin, "Untouched");
      return null;
    }
    const app = mountReact(createElement(StrictMode, null, createElement(Untouched)));
    app.unmount();
    await Promise.resolve();
    await fixture.telemetry.forceFlush();
    expect(fixture.records()).toHaveLength(0);
  });

  it("forwards HOC props and tracks bubbling interactions", async () => {
    const plugin = new frameworks.react.ReactPlugin();
    const fixture = await startFrameworkTelemetry(plugin, { enabled: false });
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const onClick = vi.fn();
    function Label({ label, onClick }: { label: string; onClick: () => void }) {
      return createElement("button", { onClick }, label);
    }
    const Tracked = frameworks.react.withAITracking(plugin, Label, undefined, "engagement-wrapper");
    expect(Tracked.displayName).toBe("withAITracking(Label)");
    const app = mountReact(
      createElement(StrictMode, null, createElement(Tracked, { label: "Forwarded", onClick })),
    );
    const button = app.host.querySelector("button")!;
    expect(button.textContent).toBe("Forwarded");
    expect(button.parentElement?.className).toBe("engagement-wrapper");
    button.click();
    button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(1);
    now = 1100;
    app.unmount();
    await Promise.resolve();
    await fixture.telemetry.forceFlush();
    expect(fixture.records()).toHaveLength(1);
    expect(fixture.records()[0].attributes).toMatchObject({
      "metric.value": 1,
      "Component Name": "Label",
    });
  });

  it("supports AITrackedComponentBase subclasses with their own activity handlers", async () => {
    const plugin = new frameworks.react.ReactPlugin();
    const fixture = await startFrameworkTelemetry(plugin, { enabled: false });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    class Tracked extends frameworks.react.AITrackedComponentBase<{ label: string }> {
      constructor(props: { label: string }) {
        super(props, plugin, "Class component");
      }
      render(): ReactNode {
        return createElement("button", { onClick: this.trackActivity }, this.props.label);
      }
    }
    const app = mountReact(createElement(Tracked, { label: "Before" }));
    app.host.querySelector("button")!.click();
    app.render(createElement(Tracked, { label: "After" }));
    now = 500;
    app.unmount();
    await Promise.resolve();
    await fixture.telemetry.forceFlush();
    expect(fixture.records()).toHaveLength(1);
    expect(fixture.records()[0].attributes).toMatchObject({
      "metric.value": 0.5,
      "Component Name": "Class component",
    });
  });

  it("isolates disabled React instances", async () => {
    const first = new frameworks.react.ReactPlugin();
    const second = new frameworks.react.ReactPlugin();
    const a = await startFrameworkTelemetry(first, { enabled: false });
    const b = await startFrameworkTelemetry(second, { enabled: false });
    first.disable();
    first.trackEvent({ name: "disabled" });
    first.enable();
    first.trackEvent({ name: "first" });
    second.trackEvent({ name: "second" });
    await Promise.all([a.telemetry.forceFlush(), b.telemetry.forceFlush()]);
    expect(a.records().map((record) => record.eventName)).toEqual(["first"]);
    expect(b.records().map((record) => record.eventName)).toEqual(["second"]);
    await a.telemetry.shutdown();
    first.trackEvent({ name: "after shutdown" });
    second.trackEvent({ name: "still alive" });
    await b.telemetry.forceFlush();
    expect(b.records().map((record) => record.eventName)).toEqual(["second", "still alive"]);
    expect(first.getConfig().enabled).toBe(false);
  });

  it("unsubscribes history on shutdown without stopping another instance", async () => {
    const history = createMemoryHistory();
    const originalListen = history.listen.bind(history);
    const unlisten = vi.fn();
    vi.spyOn(history, "listen").mockImplementation((listener) => {
      const stop = originalListen(listener);
      return () => {
        unlisten();
        stop();
      };
    });
    const first = new frameworks.react.ReactPlugin({ history });
    const second = new frameworks.react.ReactPlugin({ history });
    const a = await startFrameworkTelemetry(first);
    const b = await startFrameworkTelemetry(second);
    await Promise.all([a.waitForPages(1), b.waitForPages(1)]);
    history.push("/orders/1");
    await Promise.all([a.waitForPages(2), b.waitForPages(2)]);
    expect(a.pages()[1].spanContext?.traceId).toBe(b.pages()[1].spanContext?.traceId);
    await a.telemetry.shutdown();
    history.push("/orders/2");
    await b.waitForPages(3);
    expect(unlisten).toHaveBeenCalledTimes(1);
    await b.telemetry.shutdown();
    expect(unlisten).toHaveBeenCalledTimes(2);
  });
});
