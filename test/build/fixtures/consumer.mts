import {
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  type AzureMonitorOptions,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
  type OtlpOptions,
} from "@microsoft/opentelemetry-distro-browser";

export const version: string = OPENTELEMETRY_BROWSER_VERSION;
export const azureMonitor: AzureMonitorOptions = { connectionString: "test" };
export const otlp: OtlpOptions = { endpoint: "https://example.test/v1" };
export const options: MicrosoftOpenTelemetryBrowserOptions = { azureMonitor, otlp };
export const initialize: (
  config: MicrosoftOpenTelemetryBrowserOptions,
) => MicrosoftOpenTelemetryBrowser = useMicrosoftOpenTelemetry;
