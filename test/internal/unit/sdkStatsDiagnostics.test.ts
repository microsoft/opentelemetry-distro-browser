// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { afterEach, expect, it, vi } from "vitest";
import { createCustomerSdkStats } from "../../../src/exporter/customerSdkStats.js";
import { createInternalSdkStats, reportFailure } from "../../../src/exporter/sdkStats.js";
import { startTelemetryInstance } from "../../../src/routing/telemetryInstance.js";
import {
  getSharedRegistry,
  isReportingSdkStats,
  reportWithoutTelemetry,
} from "../../../src/shared/globalOwnership.js";
import { TEST_INSTRUMENTATION_KEY } from "../../fixtures/azureMonitor.js";
import { createInMemoryPipeline } from "../../fixtures/telemetry.js";

const owners: Array<{ shutdown(): Promise<void> }> = [];
const instrumentations: ConsoleInstrumentation[] = [];

afterEach(async () => {
  for (const instrumentation of instrumentations.splice(0)) instrumentation.disable();
  await Promise.all(owners.splice(0).map((owner) => owner.shutdown()));
  trace.disable();
  logs.disable();
  context.disable();
  propagation.disable();
  diag.disable();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  { name: "simple", Processor: SimpleLogRecordProcessor },
  { name: "batch", Processor: BatchLogRecordProcessor },
])(
  "keeps reporter failure diagnostics out of standalone $name processors without a context manager",
  async ({ Processor }) => {
    context.disable();
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", transport);
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({ processors: [new Processor({ exporter })] });
    owners.push(provider);
    const instrumentation = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
    instrumentation.setLoggerProvider(provider);
    instrumentation.enable();
    instrumentations.push(instrumentation);
    const wrappedWarn = console.warn;
    vi.spyOn(diag, "warn").mockImplementation((...args) => console.warn(...args));
    const customerStats = createCustomerSdkStats(
      { enabled: true },
      TEST_INSTRUMENTATION_KEY,
      "https://customer.example.test",
    )!;
    const internalStats = createInternalSdkStats(
      {
        instrumentationKey: TEST_INSTRUMENTATION_KEY,
        endpoint: "https://stats.example.test/v2/track",
      },
      TEST_INSTRUMENTATION_KEY,
      "https://customer.example.test",
    );
    owners.push(customerStats, internalStats);
    customerStats.count("Success", "TRACE");
    internalStats.countResponse(200, 10);
    await Promise.all([customerStats.forceFlush(), internalStats.forceFlush()]);
    await provider.forceFlush();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(diag.warn).toHaveBeenCalledTimes(2);
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
    expect(console.warn).toBe(wrappedWarn);
    console.warn("application warning");
    await provider.forceFlush();
    expect(exporter.getFinishedLogRecords()).toHaveLength(1);
  },
);

it.each([false, true])(
  "guards direct diagnostic log emission through a logs-only distribution: %s",
  async (logsOnly) => {
    const pipeline = createInMemoryPipeline();
    const instance = await startTelemetryInstance({
      resourceAttributes: {},
      spanProcessors: logsOnly ? [] : pipeline.options.spanProcessors,
      logRecordProcessors: pipeline.options.logRecordProcessors,
    });
    owners.push(instance, pipeline);
    instance.commit();
    const logger = instance.loggerProvider.getLogger("diagnostic");
    vi.spyOn(diag, "warn").mockImplementation(() => logger.emit({ body: "stats failed" }));
    reportFailure(new Error("stats failed"));
    logger.emit({ body: "application" });
    await pipeline.forceFlush();
    expect(pipeline.logExporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
      "application",
    ]);
    expect(isReportingSdkStats()).toBe(false);
  },
);

it("restores console instrumentation when a stats diagnostic logger throws", () => {
  const instrumentation = new ConsoleInstrumentation({ enabled: false, logMethods: ["warn"] });
  instrumentation.enable();
  instrumentations.push(instrumentation);
  const wrappedWarn = console.warn;
  vi.spyOn(diag, "warn").mockImplementation(() => {
    throw new Error("logger failed");
  });
  expect(() => reportFailure(new Error("stats failed"))).not.toThrow();
  expect(console.warn).toBe(wrappedWarn);
});

it("preserves an outer diagnostic guard when a nested diagnostic throws", () => {
  getSharedRegistry();
  expect(isReportingSdkStats()).toBe(false);
  reportWithoutTelemetry(() => {
    expect(isReportingSdkStats()).toBe(true);
    expect(() =>
      reportWithoutTelemetry(() => {
        throw new Error("nested diagnostic");
      }),
    ).toThrow("nested diagnostic");
    expect(isReportingSdkStats()).toBe(true);
  });
  expect(isReportingSdkStats()).toBe(false);
});
