// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { SessionLogRecordProcessor, SessionSpanProcessor } from "./session/sessionProcessors.js";
import { createSession } from "./session/createSession.js";
import { PageViewInstrumentation } from "./instrumentation/pageView/index.js";
import { PageViewLogRecordProcessor } from "./instrumentation/pageView/pageViewProcessors.js";
import { PageViewContextManager } from "./instrumentation/pageView/pageViewContextManager.js";
import type {
  MicrosoftOpenTelemetryBrowser,
  MicrosoftOpenTelemetryBrowserOptions,
} from "./types.js";

/**
 * Builds the page-view instrumentation this distribution owns and turns on by itself.
 *
 * @remarks
 * Distribution-owned instrumentations are selected by configuration rather than by import,
 * because a bundler resolves imports before the application ever supplies its options. Page view
 * is on unless it is switched off.
 *
 * Returns nothing outside a browser. This entry point is routinely imported by a server-rendered
 * build, and these instrumentations observe the DOM, so constructing one there would throw during
 * initialization and take the host application down with it.
 *
 * It is constructed with `enabled: false` so that collection starts only once the registration
 * loop below has bound its trace and log providers.
 */
function createPageViewInstrumentation(
  options: MicrosoftOpenTelemetryBrowserOptions,
): PageViewInstrumentation | undefined {
  if (typeof document === "undefined" || typeof location === "undefined") return;

  const pageView = options.pageView ?? {};
  if (pageView.enabled !== false) {
    return new PageViewInstrumentation({ ...pageView, enabled: false });
  }
}

/**
 * Restores the session when enabled, then initializes traces, logs, and selected instrumentations.
 * Await completion before emitting telemetry.
 * @public
 */
export async function useMicrosoftOpenTelemetry(
  options: MicrosoftOpenTelemetryBrowserOptions = {},
): Promise<MicrosoftOpenTelemetryBrowser> {
  const session = options.session?.enabled === true ? createSession() : undefined;
  const spanProcessors = options.spanProcessors?.slice();
  const logRecordProcessors = options.logRecordProcessors?.slice();
  const traceOptions = options.traces;
  const pageView = createPageViewInstrumentation(options);
  // Publish the page operation before caller instrumentations can emit during enable or navigation.
  const instrumentations = [...(pageView ? [pageView] : []), ...(options.instrumentations ?? [])];
  let sdk: MicrosoftOpenTelemetryBrowser | undefined;
  let stopping = false;
  // Upstream stale tracers can still call processors after provider shutdown.
  const sessionProvider = {
    getSessionId: () => (stopping ? null : (session?.getSessionId() ?? null)),
  };
  const getPageView = () => (stopping ? undefined : pageView?.pageViews.getCurrentPageView());
  const pageContextManager =
    pageView && spanProcessors?.length !== 0
      ? new PageViewContextManager(getPageView, traceOptions?.contextManager)
      : undefined;

  let shutdownPromise: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    return (shutdownPromise ??= (async () => {
      stopping = true;
      pageContextManager?.shutdown();
      const errors: unknown[] = [];
      try {
        session?.shutdown();
      } catch (error) {
        errors.push(error);
      }
      for (let i = sdk ? instrumentations.length - 1 : -1; i >= 0; i--) {
        try {
          instrumentations[i].disable();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await sdk?.shutdown();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Telemetry shutdown failed");
    })());
  }

  try {
    await session?.start();
    const internalLogProcessors = [
      ...(session ? [new SessionLogRecordProcessor(sessionProvider)] : []),
      ...(pageView ? [new PageViewLogRecordProcessor(getPageView)] : []),
    ];
    sdk = startBrowserSdk({
      traces: {
        ...(pageContextManager
          ? { contextManager: pageContextManager }
          : traceOptions?.contextManager === undefined
            ? {}
            : { contextManager: traceOptions.contextManager }),
        ...(traceOptions?.propagators === undefined
          ? {}
          : { propagators: traceOptions.propagators.slice() }),
        processors:
          session && spanProcessors?.length !== 0
            ? [new SessionSpanProcessor(sessionProvider), ...(spanProcessors ?? [])]
            : spanProcessors,
        // Supplying enrichment processors must not disable upstream default export.
        ...(session && spanProcessors === undefined ? { exportConfig: {} } : {}),
      },
      logs: {
        processors:
          internalLogProcessors.length && logRecordProcessors?.length !== 0
            ? [...internalLogProcessors, ...(logRecordProcessors ?? [])]
            : logRecordProcessors,
        ...(internalLogProcessors.length && logRecordProcessors === undefined
          ? { exportConfig: {} }
          : {}),
      },
    });
    const tracerProvider = trace.getTracerProvider();
    const loggerProvider = logs.getLoggerProvider();
    for (const instrumentation of instrumentations) {
      instrumentation.setTracerProvider(tracerProvider);
      instrumentation.setLoggerProvider?.(loggerProvider);
      if (!instrumentation.getConfig().enabled) instrumentation.enable();
    }
  } catch (error) {
    try {
      await shutdown();
    } catch (cleanupError) {
      diag.error("Telemetry initialization cleanup failed", cleanupError);
    }
    throw error;
  }

  return { shutdown };
}
