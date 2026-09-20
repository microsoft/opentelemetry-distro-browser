// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  DiagLogLevel,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  context,
  createContextKey,
  diag,
  propagation,
  trace,
  type TextMapPropagator,
} from "@opentelemetry/api";
import { SeverityNumber, logs } from "@opentelemetry/api-logs";
import { detectResources, resourceFromAttributes } from "@opentelemetry/resources";
import { LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, type SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { name, version } from "../../../package.json";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

const handles = new Set<MicrosoftOpenTelemetryBrowser>();

function initialize(options: MicrosoftOpenTelemetryBrowserOptions) {
  const handle = useMicrosoftOpenTelemetry(options);
  handles.add(handle);
  return handle;
}

function spanProcessor(overrides: Partial<SpanProcessor> = {}): SpanProcessor {
  return {
    onStart: vi.fn(),
    onEnding: vi.fn(),
    onEnd: vi.fn(),
    forceFlush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  };
}

function logProcessor(overrides: Partial<LogRecordProcessor> = {}): LogRecordProcessor {
  return {
    onEmit: vi.fn(),
    forceFlush: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
    ...overrides,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  const results = await Promise.allSettled([...handles].map((handle) => handle.shutdown()));
  handles.clear();
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
  if (vi.isFakeTimers()) {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
});

describe("initialization", () => {
  it("exports manual spans and logs through upstream batch processors on flush", async () => {
    const pipeline = createInMemoryPipeline();
    const tracer = trace.getTracer("manual", "1.2.3");
    const logger = logs.getLogger("manual", "1.2.3");
    const resource = resourceFromAttributes(
      { "service.name": "checkout", "service.version": "2.0", "browser.test": true },
      { schemaUrl: "https://example.com/schema" },
    );
    const handle = initialize({ ...pipeline.options, resource });
    const span = tracer.startSpan("checkout", {
      kind: SpanKind.CLIENT,
      attributes: { "cart.item_count": 3 },
    });
    const spanContext = trace.setSpan(ROOT_CONTEXT, span);
    span.addEvent("submitted");
    span.setStatus({ code: SpanStatusCode.OK });
    logger.emit({
      eventName: "checkout.started",
      severityNumber: SeverityNumber.INFO,
      body: "checkout",
      attributes: { "cart.item_count": 3 },
      context: spanContext,
    });
    span.end();

    expect(pipeline.spanExporter.getFinishedSpans()).toHaveLength(0);
    expect(pipeline.logExporter.getFinishedLogRecords()).toHaveLength(0);
    await handle.forceFlush();

    const [exportedSpan] = pipeline.spanExporter.getFinishedSpans();
    const [exportedLog] = pipeline.logExporter.getFinishedLogRecords();
    expect(exportedSpan).toMatchObject({
      name: "checkout",
      kind: SpanKind.CLIENT,
      attributes: { "cart.item_count": 3 },
      status: { code: SpanStatusCode.OK },
      instrumentationScope: { name: "manual", version: "1.2.3" },
    });
    expect(exportedSpan.events[0].name).toBe("submitted");
    expect(exportedLog).toMatchObject({
      eventName: "checkout.started",
      body: "checkout",
      severityNumber: SeverityNumber.INFO,
      attributes: { "cart.item_count": 3 },
      instrumentationScope: { name: "manual", version: "1.2.3" },
      spanContext: span.spanContext(),
    });
    expect(exportedSpan.resource).toBe(exportedLog.resource);
    expect(exportedSpan.resource.schemaUrl).toBe("https://example.com/schema");
    expect(exportedSpan.resource.attributes).toMatchObject({
      "service.name": "checkout",
      "service.version": "2.0",
      "telemetry.sdk.name": "opentelemetry",
      "telemetry.sdk.language": "webjs",
      "telemetry.distro.name": name,
      "telemetry.distro.version": version,
      "browser.test": true,
    });
    expect(resource.attributes).toEqual({
      "service.name": "checkout",
      "service.version": "2.0",
      "browser.test": true,
    });
  });

  it("preserves asynchronous resource attributes until export", async () => {
    const pipeline = createInMemoryPipeline();
    const resource = detectResources({
      detectors: [{ detect: () => ({ attributes: { "test.async": Promise.resolve("ready") } }) }],
    });
    const handle = initialize({ ...pipeline.options, resource });
    trace.getTracer("test").startSpan("async-resource").end();
    logs.getLogger("test").emit({ eventName: "async-resource" });
    await handle.forceFlush();
    expect(pipeline.spanExporter.getFinishedSpans()[0].resource.attributes["test.async"]).toBe(
      "ready",
    );
    expect(pipeline.logExporter.getFinishedLogRecords()[0].resource.attributes["test.async"]).toBe(
      "ready",
    );
  });

  it("uses default service, SDK and distribution resources when omitted", async () => {
    const pipeline = createInMemoryPipeline();
    const handle = initialize(pipeline.options);
    trace.getTracer("test").startSpan("defaults").end();
    await handle.forceFlush();
    const attributes = pipeline.spanExporter.getFinishedSpans()[0].resource.attributes;
    expect(attributes["service.name"]).toMatch(/^unknown_service/);
    expect(attributes["telemetry.sdk.version"]).toBe("2.11.0");
    expect(attributes["telemetry.distro.version"]).toBe(version);
  });

  it("warns for an empty pipeline and still returns a working lifecycle handle", async () => {
    const warn = vi.fn();
    diag.setLogger(
      { warn, error: vi.fn(), info: vi.fn(), debug: vi.fn(), verbose: vi.fn() },
      DiagLogLevel.ALL,
    );
    const handle = initialize({});
    expect(warn).toHaveBeenCalledWith(
      "No processors configured; browser telemetry will not be exported.",
    );
    await handle.forceFlush();
    await handle.shutdown();
    expect(handle.forceFlush()).toBe(handle.shutdown());
  });

  it.each(["traces", "logs"] as const)("supports a %s-only pipeline", async (signal) => {
    const span = spanProcessor();
    const log = logProcessor();
    const handle = initialize(
      signal === "traces" ? { spanProcessors: [span] } : { logRecordProcessors: [log] },
    );
    trace.getTracer("test").startSpan("manual").end();
    logs.getLogger("test").emit({ eventName: "manual" });
    await handle.forceFlush();
    expect(span.onEnd).toHaveBeenCalledTimes(signal === "traces" ? 1 : 0);
    expect(log.onEmit).toHaveBeenCalledTimes(signal === "logs" ? 1 : 0);
  });

  it("copies processor arrays and sampling options without freezing caller objects", async () => {
    const span = spanProcessor();
    const log = logProcessor();
    const replacementSpan = spanProcessor();
    const replacementLog = logProcessor();
    const options = { spanProcessors: [span], logRecordProcessors: [log], samplingRatio: 1 };
    const handle = initialize(options);
    options.spanProcessors.splice(0, 1, replacementSpan);
    options.logRecordProcessors.splice(0, 1, replacementLog);
    options.samplingRatio = 0;
    expect(Object.isFrozen(options)).toBe(false);
    expect(Object.isFrozen(span)).toBe(false);
    trace.getTracer("test").startSpan("original").end();
    logs.getLogger("test").emit({ eventName: "original" });
    await handle.forceFlush();
    expect(span.onEnd).toHaveBeenCalledOnce();
    expect(log.onEmit).toHaveBeenCalledOnce();
    expect(replacementSpan.onEnd).not.toHaveBeenCalled();
    expect(replacementLog.onEmit).not.toHaveBeenCalled();
    await handle.shutdown();
    expect(span.shutdown).toHaveBeenCalledOnce();
    expect(log.shutdown).toHaveBeenCalledOnce();
    expect(replacementSpan.shutdown).not.toHaveBeenCalled();
    expect(replacementLog.shutdown).not.toHaveBeenCalled();
  });

  it("accepts frozen option containers and retains processor method receivers", async () => {
    const span: SpanProcessor & { starts: number } = {
      ...spanProcessor(),
      starts: 0,
      onStart() {
        this.starts++;
      },
    };
    const log: LogRecordProcessor & { emitted: number } = {
      ...logProcessor(),
      emitted: 0,
      onEmit() {
        this.emitted++;
      },
      enabled() {
        return this.emitted === 0;
      },
    };
    const handle = initialize(
      Object.freeze({
        spanProcessors: Object.freeze([span]),
        logRecordProcessors: Object.freeze([log]),
      }),
    );
    trace.getTracer("test").startSpan("receiver").end();
    logs.getLogger("test").emit({ eventName: "first" });
    logs.getLogger("test").emit({ eventName: "filtered" });
    expect(span.starts).toBe(1);
    expect(log.emitted).toBe(1);
    await handle.shutdown();
  });
});

describe("sampling and propagation", () => {
  it.each([0, 1])("applies samplingRatio=%s to root spans but not logs", (samplingRatio) => {
    const span = spanProcessor();
    const log = logProcessor();
    initialize({ samplingRatio, spanProcessors: [span], logRecordProcessors: [log] });
    const recording = trace.getTracer("test").startSpan("root");
    expect(recording.isRecording()).toBe(samplingRatio === 1);
    recording.end();
    logs.getLogger("test").emit({ eventName: "not-sampled" });
    expect(span.onEnd).toHaveBeenCalledTimes(samplingRatio);
    expect(log.onEmit).toHaveBeenCalledOnce();
  });

  it.each([
    { samplingRatio: 0, traceFlags: TraceFlags.SAMPLED, recording: true },
    { samplingRatio: 1, traceFlags: TraceFlags.NONE, recording: false },
  ])("honors the parent sampling decision: %j", ({ samplingRatio, traceFlags, recording }) => {
    initialize({ samplingRatio, spanProcessors: [spanProcessor()] });
    const parent = {
      traceId: "12345678901234567890123456789012",
      spanId: "1234567890123456",
      traceFlags,
      isRemote: true,
    };
    const child = trace
      .getTracer("test")
      .startSpan("child", {}, trace.setSpanContext(ROOT_CONTEXT, parent));
    expect(child.isRecording()).toBe(recording);
    expect(child.spanContext().traceId).toBe(parent.traceId);
    child.end();
  });

  it("injects and extracts W3C trace context and baggage without patching requests", () => {
    const originalFetch = window.fetch;
    const originalXhr = window.XMLHttpRequest;
    initialize({ spanProcessors: [spanProcessor()] });
    const parent = {
      traceId: "12345678901234567890123456789012",
      spanId: "1234567890123456",
      traceFlags: TraceFlags.SAMPLED,
    };
    const active = propagation.setBaggage(
      trace.setSpanContext(ROOT_CONTEXT, parent),
      propagation.createBaggage({ tenant: { value: "example" } }),
    );
    const carrier: Record<string, string> = {};
    propagation.inject(active, carrier);
    expect(carrier.traceparent).toBe("00-12345678901234567890123456789012-1234567890123456-01");
    expect(carrier.baggage).toBe("tenant=example");
    const extracted = propagation.extract(ROOT_CONTEXT, carrier);
    expect(trace.getSpanContext(extracted)).toMatchObject({ ...parent, isRemote: true });
    expect(propagation.getBaggage(extracted)?.getEntry("tenant")?.value).toBe("example");
    expect(window.fetch).toBe(originalFetch);
    expect(window.XMLHttpRequest).toBe(originalXhr);
  });

  it("passes through a custom propagator without adding the default fields", () => {
    const propagator: TextMapPropagator = {
      fields: () => ["custom"],
      inject: vi.fn(),
      extract: vi.fn((context) => context),
    };
    initialize({ propagator, spanProcessors: [spanProcessor()] });
    const carrier = {};
    propagation.inject(ROOT_CONTEXT, carrier);
    expect(propagator.inject).toHaveBeenCalled();
    expect(propagation.extract(ROOT_CONTEXT, carrier)).toBe(ROOT_CONTEXT);
    expect(propagator.extract).toHaveBeenCalled();
    expect(propagation.fields()).toEqual(["custom"]);
  });

  it("leaves an application-provided context manager registered", async () => {
    const manager = new StackContextManager().enable();
    const disable = vi.spyOn(manager, "disable");
    expect(context.setGlobalContextManager(manager)).toBe(true);
    const key = createContextKey("test");
    const active = ROOT_CONTEXT.setValue(key, "preserved");
    const handle = initialize({ spanProcessors: [spanProcessor()] });
    expect(context.with(active, () => context.active().getValue(key))).toBe("preserved");
    await handle.shutdown();
    expect(disable).not.toHaveBeenCalled();
    expect(context.with(active, () => context.active().getValue(key))).toBe("preserved");
  });
});

describe("validation and registration", () => {
  it.each(
    [
      undefined,
      null,
      [],
      { samplingRatio: NaN },
      { samplingRatio: Infinity },
      { samplingRatio: -0.1 },
      { samplingRatio: 1.1 },
      { samplingRatio: "1" },
      { samplingRatio: null },
      { spanProcessors: null },
      { logRecordProcessors: {} },
      { instrumentationOptions: {} },
      { session: {} },
      { propagateToUrls: [] },
    ].map((options) => ({ options })),
  )("rejects invalid distribution options before changing globals: %j", ({ options }) => {
    const registerTrace = vi.spyOn(trace, "setGlobalTracerProvider");
    const registerLogs = vi.spyOn(logs, "setGlobalLoggerProvider");
    const registerPropagation = vi.spyOn(propagation, "setGlobalPropagator");
    expect(() => Reflect.apply(useMicrosoftOpenTelemetry, undefined, [options])).toThrow();
    expect(registerTrace).not.toHaveBeenCalled();
    expect(registerLogs).not.toHaveBeenCalled();
    expect(registerPropagation).not.toHaveBeenCalled();
  });

  it.each([
    { azureMonitor: { connectionString: "InstrumentationKey=example" } },
    { otlp: { endpoint: "https://collector.example.com" } },
  ])("rejects an unsupported destination without taking processor ownership: %j", (preset) => {
    const span = spanProcessor();
    const log = logProcessor();
    expect(() =>
      useMicrosoftOpenTelemetry({
        ...preset,
        spanProcessors: [span],
        logRecordProcessors: [log],
      }),
    ).toThrow("Destination presets are not implemented");
    expect(span.shutdown).not.toHaveBeenCalled();
    expect(log.shutdown).not.toHaveBeenCalled();
    initialize({ spanProcessors: [span], logRecordProcessors: [log] });
  });

  it("rejects a second initialization without altering the active pipeline", () => {
    const original = spanProcessor();
    const rejected = spanProcessor();
    initialize({ spanProcessors: [original] });
    expect(() => useMicrosoftOpenTelemetry({ spanProcessors: [rejected] })).toThrow(
      "already initialized",
    );
    trace.getTracer("test").startSpan("original").end();
    expect(original.onEnd).toHaveBeenCalledOnce();
    expect(rejected.onEnd).not.toHaveBeenCalled();
    expect(rejected.shutdown).not.toHaveBeenCalled();
  });

  it.each(["propagator", "logger", "tracer"] as const)(
    "does not overwrite an existing %s registration and rolls back its own registrations",
    async (kind) => {
      const originalPropagator: TextMapPropagator = {
        fields: () => ["existing"],
        inject() {},
        extract: (context) => context,
      };
      const originalLoggerProvider = new LoggerProvider();
      const originalTracerProvider = new BasicTracerProvider();
      if (kind === "propagator") propagation.setGlobalPropagator(originalPropagator);
      if (kind === "logger") logs.setGlobalLoggerProvider(originalLoggerProvider);
      if (kind === "tracer") trace.setGlobalTracerProvider(originalTracerProvider);
      const registeredTrace = trace.getTracerProvider();
      const span = spanProcessor();
      const log = logProcessor();
      expect(() =>
        useMicrosoftOpenTelemetry({ spanProcessors: [span], logRecordProcessors: [log] }),
      ).toThrow(`global ${kind}`);
      expect(trace.getTracerProvider()).toBe(registeredTrace);
      expect(propagation.fields()).toEqual(kind === "propagator" ? ["existing"] : []);
      if (kind === "logger") expect(logs.getLoggerProvider()).toBe(originalLoggerProvider);
      expect(span.shutdown).not.toHaveBeenCalled();
      expect(log.shutdown).not.toHaveBeenCalled();
      trace.disable();
      logs.disable();
      propagation.disable();
      await originalTracerProvider.shutdown();
      await originalLoggerProvider.shutdown();
      initialize({ spanProcessors: [span], logRecordProcessors: [log] });
    },
  );

  it("recovers from a resource merge failure before registration", () => {
    const failure = new Error("resource failure");
    const options = {
      resource: {
        getRawAttributes() {
          throw failure;
        },
      },
    };
    expect(() => Reflect.apply(useMicrosoftOpenTelemetry, undefined, [options])).toThrow(failure);
    expect(propagation.fields()).toEqual([]);
    initialize({ spanProcessors: [spanProcessor()] });
  });

  it("preserves pre-initialization API loggers across a rolled-back registration", async () => {
    const foreign = new BasicTracerProvider();
    trace.setGlobalTracerProvider(foreign);
    const logger = logs.getLogger("pre-initialization");
    const rejected = logProcessor();
    expect(() => useMicrosoftOpenTelemetry({ logRecordProcessors: [rejected] })).toThrow(
      "global tracer provider",
    );
    logger.emit({ eventName: "before-retry" });
    expect(rejected.onEmit).not.toHaveBeenCalled();
    trace.disable();
    await foreign.shutdown();
    const accepted = logProcessor();
    initialize({ logRecordProcessors: [accepted] });
    logger.emit({ eventName: "after-retry" });
    expect(accepted.onEmit).toHaveBeenCalledOnce();
    expect(accepted.onEmit).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: "after-retry" }),
      expect.anything(),
    );
  });
});

describe("lifecycle", () => {
  it("delegates flushing and reports failures from both signal providers", async () => {
    const spanFailure = new Error("trace flush failed");
    const logFailure = new Error("log flush failed");
    const firstSpan = spanProcessor({
      forceFlush: vi.fn(() => {
        throw spanFailure;
      }),
    });
    const secondSpan = spanProcessor();
    const firstLog = logProcessor({
      forceFlush: vi.fn(() => {
        throw logFailure;
      }),
    });
    const secondLog = logProcessor();
    const handle = initialize({
      spanProcessors: [firstSpan, secondSpan],
      logRecordProcessors: [firstLog, secondLog],
    });
    await expect(handle.forceFlush()).rejects.toMatchObject({
      errors: [[spanFailure], logFailure],
    });
    expect(firstSpan.forceFlush).toHaveBeenCalledOnce();
    expect(secondSpan.forceFlush).toHaveBeenCalledOnce();
    expect(firstLog.forceFlush).toHaveBeenCalledOnce();
    expect(secondLog.forceFlush).toHaveBeenCalledOnce();
    await handle.shutdown();
    expect(firstSpan.shutdown).toHaveBeenCalledOnce();
    expect(firstLog.shutdown).toHaveBeenCalledOnce();
  });

  it("serializes flushes and waits for the in-flight flush before shutdown", async () => {
    const pending = deferred();
    const first = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const span = spanProcessor({ forceFlush: first });
    const log = logProcessor();
    const handle = initialize({ spanProcessors: [span], logRecordProcessors: [log] });
    const flushOne = handle.forceFlush();
    const flushTwo = handle.forceFlush();
    const stopped = handle.shutdown();
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(span.shutdown).not.toHaveBeenCalled();
    expect(log.shutdown).not.toHaveBeenCalled();
    expect(handle.forceFlush()).toBe(stopped);
    expect(() => useMicrosoftOpenTelemetry({})).toThrow("shutting down");
    pending.resolve();
    await Promise.all([flushOne, flushTwo, stopped]);
    expect(first).toHaveBeenCalledTimes(2);
    expect(log.forceFlush).toHaveBeenCalledTimes(2);
    expect(span.shutdown).toHaveBeenCalledOnce();
    expect(log.shutdown).toHaveBeenCalledOnce();
  });

  it("uses upstream flush timeouts and can still shut down", async () => {
    vi.useFakeTimers();
    const never = () => new Promise<void>(() => {});
    const handle = initialize({
      spanProcessors: [spanProcessor({ forceFlush: never })],
      logRecordProcessors: [logProcessor({ forceFlush: never })],
    });
    const outcome = handle.forceFlush().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await outcome).toBeInstanceOf(AggregateError);
    await handle.shutdown();
  });

  it("flushes upstream batch processors during shutdown", async () => {
    const pipeline = createInMemoryPipeline();
    const spanExport = vi.spyOn(pipeline.spanExporter, "export");
    const logExport = vi.spyOn(pipeline.logExporter, "export");
    const handle = initialize(pipeline.options);
    trace.getTracer("test").startSpan("last-span").end();
    logs.getLogger("test").emit({ eventName: "last-log" });
    await handle.shutdown();
    expect(spanExport.mock.calls[0][0][0].name).toBe("last-span");
    expect(logExport.mock.calls[0][0][0].eventName).toBe("last-log");
  });

  it("makes shutdown idempotent and blocks stale telemetry immediately", async () => {
    const pending = deferred();
    const span = spanProcessor({ shutdown: vi.fn(() => pending.promise) });
    const log = logProcessor();
    const handle = initialize({ spanProcessors: [span], logRecordProcessors: [log] });
    const tracer = trace.getTracer("old");
    const logger = logs.getLogger("old");
    const late = tracer.startSpan("late");
    const stopped = handle.shutdown();
    expect(handle.shutdown()).toBe(stopped);
    expect(logger.enabled()).toBe(false);
    logger.emit({ eventName: "after-shutdown" });
    late.end();
    expect(tracer.startSpan("after-shutdown").isRecording()).toBe(false);
    expect(span.onEnd).not.toHaveBeenCalled();
    expect(log.onEmit).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(span.shutdown).toHaveBeenCalledOnce());
    pending.resolve();
    await stopped;
    expect(log.shutdown).toHaveBeenCalledOnce();
    expect(handle.shutdown()).toBe(stopped);
    expect(propagation.fields()).toEqual([]);

    const nextSpan = spanProcessor();
    initialize({ spanProcessors: [nextSpan] });
    tracer.startSpan("still-stale").end();
    logger.emit({ eventName: "still-stale" });
    expect(nextSpan.onEnd).not.toHaveBeenCalled();
    trace.getTracer("new").startSpan("new").end();
    expect(nextSpan.onEnd).toHaveBeenCalledOnce();
  });

  it("preserves the shutdown failure and permits a fresh instance after cleanup", async () => {
    const spanFailure = new Error("span shutdown failed");
    const logFailure = new Error("log shutdown failed");
    const span = spanProcessor({
      shutdown: vi.fn(() => {
        throw spanFailure;
      }),
    });
    const log = logProcessor({
      shutdown: vi.fn(() => {
        throw logFailure;
      }),
    });
    const handle = initialize({ spanProcessors: [span], logRecordProcessors: [log] });
    const stopped = handle.shutdown();
    await expect(stopped).rejects.toMatchObject({ errors: [spanFailure, logFailure] });
    expect(handle.shutdown()).toBe(stopped);
    expect(handle.forceFlush()).toBe(stopped);
    expect(span.shutdown).toHaveBeenCalledOnce();
    expect(log.shutdown).toHaveBeenCalledOnce();
    handles.delete(handle);
    expect(propagation.fields()).toEqual([]);
    initialize({ spanProcessors: [spanProcessor()] });
  });

  it.each(["forceFlush", "shutdown"] as const)(
    "preserves upstream %s rejection timing instead of waiting for sibling processors",
    async (method) => {
      const pending = deferred();
      const failure = new Error("provider operation failed");
      const delayed = vi.fn(() => pending.promise);
      const handle = initialize({
        logRecordProcessors: [
          logProcessor({
            [method]: async () => {
              throw failure;
            },
          }),
          logProcessor({ [method]: delayed }),
        ],
      });
      let settled = false;
      const outcome = handle[method]()
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      try {
        await vi.waitFor(() => expect(settled).toBe(true));
        expect(delayed).toHaveBeenCalledOnce();
        expect(await outcome).toMatchObject({ errors: [failure] });
      } finally {
        pending.resolve();
        await outcome;
        if (method === "shutdown") handles.delete(handle);
      }
    },
  );
});
