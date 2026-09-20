// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag, propagation, trace } from "@opentelemetry/api";
import { logs, type LoggerProvider as ApiLoggerProvider } from "@opentelemetry/api-logs";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import {
  BasicTracerProvider,
  ParentBasedSampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  ATTR_TELEMETRY_DISTRO_NAME,
  ATTR_TELEMETRY_DISTRO_VERSION,
} from "@opentelemetry/semantic-conventions/incubating";
import { normalizeConfiguration } from "./internal/configuration.js";
import { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "./types.js";

let inUse = false;

async function runAll(
  providers: readonly MicrosoftOpenTelemetryBrowser[],
  method: "forceFlush" | "shutdown",
): Promise<void> {
  const results = await Promise.allSettled(providers.map(async (provider) => provider[method]()));
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      failures.push(result.reason);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Browser telemetry ${method} failed.`);
  }
}

/**
 * Initialize the single-instance browser distribution with upstream processors.
 *
 * @remarks
 * Registers trace and log providers and a propagator without installing
 * instrumentation or a context manager. Pass explicit OpenTelemetry Context
 * values for parenting and correlation. Empty processor lists are supported
 * but produce a diagnostic warning because no telemetry will be exported.
 * Destination presets are not implemented yet.
 *
 * @param options - Configuration for the browser distribution.
 * @returns The lifecycle handle for the initialized distribution.
 * @throws Error - Invalid or unsupported distribution options, an active instance,
 * or a required global registration already owned by another SDK.
 * @public
 */
export function useMicrosoftOpenTelemetry(
  options: MicrosoftOpenTelemetryBrowserOptions,
): MicrosoftOpenTelemetryBrowser {
  if (inUse) {
    throw new Error("Browser telemetry is already initialized or shutting down.");
  }
  const config = normalizeConfiguration(options);
  const registrations: (() => void)[] = [];
  let accepting = false;
  let initializationFailed = false;

  function unregister() {
    for (const release of registrations.reverse()) {
      release();
    }
    registrations.length = 0;
  }

  inUse = true;
  try {
    const resource = defaultResource()
      .merge(
        resourceFromAttributes({
          [ATTR_TELEMETRY_DISTRO_NAME]: "@microsoft/opentelemetry-distro-browser",
          [ATTR_TELEMETRY_DISTRO_VERSION]: OPENTELEMETRY_BROWSER_VERSION,
        }),
      )
      .merge(config.resource ?? null);
    const sampler = new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.samplingRatio),
    });
    const tracerProvider = new BasicTracerProvider({
      resource,
      sampler: {
        shouldSample(context, traceId, name, kind, attributes, links) {
          return accepting
            ? sampler.shouldSample(context, traceId, name, kind, attributes, links)
            : { decision: SamplingDecision.NOT_RECORD };
        },
        toString: () => sampler.toString(),
      },
      spanProcessors: config.spanProcessors.map((processor): SpanProcessor => ({
        forceFlush: async () => processor.forceFlush(),
        shutdown: async () => processor.shutdown(),
        onStart: (span, context) => processor.onStart(span, context),
        onEnding(span) {
          if (accepting) processor.onEnding?.(span);
        },
        onEnd(span) {
          if (accepting) processor.onEnd(span);
        },
      })),
    });
    const loggerProvider = new LoggerProvider({
      resource,
      processors: config.logRecordProcessors.map((processor): LogRecordProcessor => ({
        forceFlush: async () => processor.forceFlush(),
        shutdown: async () => processor.shutdown(),
        enabled(options) {
          return accepting && (processor.enabled?.(options) ?? true);
        },
        onEmit: (record, context) => processor.onEmit(record, context),
      })),
    });
    const providers = [tracerProvider, loggerProvider];
    // Pre-initialization API loggers must survive a rolled-back registration.
    const loggerRegistration: ApiLoggerProvider = {
      getLogger(name, version, options) {
        const provider = initializationFailed ? logs.getLoggerProvider() : loggerProvider;
        return provider.getLogger(name, version, options);
      },
    };
    const propagator =
      config.propagator ??
      new CompositePropagator({
        propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
      });

    if (config.spanProcessors.length === 0 && config.logRecordProcessors.length === 0) {
      diag.warn("No processors configured; browser telemetry will not be exported.");
    }
    if (!propagation.setGlobalPropagator(propagator)) {
      throw new Error("A global propagator is already registered.");
    }
    registrations.push(() => propagation.disable());
    if (logs.setGlobalLoggerProvider(loggerRegistration) !== loggerRegistration) {
      throw new Error("A global logger provider is already registered.");
    }
    registrations.push(() => {
      if (logs.getLoggerProvider() === loggerRegistration) logs.disable();
    });
    if (!trace.setGlobalTracerProvider(tracerProvider)) {
      throw new Error("A global tracer provider is already registered.");
    }
    const registeredTracerProvider = trace.getTracerProvider();
    registrations.push(() => {
      if (trace.getTracerProvider() === registeredTracerProvider) trace.disable();
    });
    accepting = true;

    let pendingFlush = Promise.resolve();
    let shutdownPromise: Promise<void> | undefined;
    return {
      forceFlush() {
        if (shutdownPromise) return shutdownPromise;
        const flush = () => runAll(providers, "forceFlush");
        pendingFlush = pendingFlush.then(flush, flush);
        return pendingFlush;
      },
      shutdown() {
        if (!shutdownPromise) {
          accepting = false;
          const stop = async () => {
            unregister();
            await runAll(providers, "shutdown");
          };
          shutdownPromise = pendingFlush.then(stop, stop).finally(() => {
            inUse = false;
          });
        }
        return shutdownPromise;
      },
    };
  } catch (error) {
    initializationFailed = true;
    unregister();
    inUse = false;
    // These providers only reference caller-owned processors; do not shut them down.
    throw error;
  }
}
