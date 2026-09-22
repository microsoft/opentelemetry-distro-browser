import {
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
  type OtlpOptions,
} from "@microsoft/opentelemetry-distro-browser";

export const version: string = OPENTELEMETRY_BROWSER_VERSION;
export const otlp: OtlpOptions = {
  endpoint: "https://example.test",
  headers: { "x-tenant": "consumer" },
};
export const options: MicrosoftOpenTelemetryBrowserOptions = {
  otlp,
  spanProcessors: [],
  logRecordProcessors: [],
};
export const initialize: (
  config: MicrosoftOpenTelemetryBrowserOptions,
) => MicrosoftOpenTelemetryBrowser = useMicrosoftOpenTelemetry;
// @ts-expect-error The previous distribution-specific option is no longer supported.
useMicrosoftOpenTelemetry({ samplingRatio: 1 });
// @ts-expect-error Service/resource configuration is not part of the supported options yet.
useMicrosoftOpenTelemetry({ serviceName: "consumer" });
// @ts-expect-error Upstream SDK controls are not exposed by the distro.
useMicrosoftOpenTelemetry({ disabled: true });
// @ts-expect-error Use the distro's otlp option instead of upstream exportConfig.
useMicrosoftOpenTelemetry({ exportConfig: { url: "https://example.test" } });
// @ts-expect-error Processors are top-level distro options, not upstream signal configuration.
useMicrosoftOpenTelemetry({ traces: { processors: [] } });
// @ts-expect-error Processors are top-level distro options, not upstream signal configuration.
useMicrosoftOpenTelemetry({ logs: { processors: [] } });

export async function shutdown(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  await handle.shutdown();
  // @ts-expect-error The upstream lifecycle handle does not expose forceFlush().
  await handle.forceFlush();
}
