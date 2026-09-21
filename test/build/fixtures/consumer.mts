import {
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  useMicrosoftOpenTelemetryTraces as useTraces,
  useMicrosoftOpenTelemetryLogs as useLogs,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
  type MicrosoftOpenTelemetryBrowserTraceOptions,
  type MicrosoftOpenTelemetryBrowserLogOptions,
} from "@microsoft/opentelemetry-distro-browser";

export const version: string = OPENTELEMETRY_BROWSER_VERSION;
export const options: MicrosoftOpenTelemetryBrowserOptions = {
  serviceName: "consumer",
  exportConfig: { url: "https://example.test" },
  traces: { processors: [] },
  logs: { processors: [] },
};
export const initialize: (
  config: MicrosoftOpenTelemetryBrowserOptions,
) => MicrosoftOpenTelemetryBrowser = useMicrosoftOpenTelemetry;
export const initializeTraces: (
  config: MicrosoftOpenTelemetryBrowserTraceOptions,
) => MicrosoftOpenTelemetryBrowser = useTraces;
export const initializeLogs: (
  config: MicrosoftOpenTelemetryBrowserLogOptions,
) => MicrosoftOpenTelemetryBrowser = useLogs;

// @ts-expect-error The trace initializer does not accept log-specific limits.
useTraces({ logRecordLimits: {} });
// @ts-expect-error The log initializer does not accept span-specific limits.
useLogs({ spanLimits: {} });
// @ts-expect-error The previous distribution-specific option is no longer supported.
useMicrosoftOpenTelemetry({ samplingRatio: 1 });

export async function shutdown(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  await handle.shutdown();
  // @ts-expect-error The upstream lifecycle handle does not expose forceFlush().
  await handle.forceFlush();
}
