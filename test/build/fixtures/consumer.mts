import {
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  type BrowserInstrumentation,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "@microsoft/opentelemetry-distro-browser";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

export const version: string = OPENTELEMETRY_BROWSER_VERSION;
const headers = { "x-tenant": "consumer" };
export const instrumentation: BrowserInstrumentation = {
  setTracerProvider(provider) {
    provider.getTracer("consumer");
  },
  setLoggerProvider(provider) {
    provider.getLogger("consumer");
  },
  getConfig() {
    return { enabled: false };
  },
  enable() {},
  disable() {},
};
export const options: MicrosoftOpenTelemetryBrowserOptions = {
  session: { enabled: true },
  instrumentations: Object.freeze([instrumentation]),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({ url: "https://example.test/v1/traces", headers }),
    ),
  ],
  logRecordProcessors: [
    new BatchLogRecordProcessor({
      exporter: new OTLPLogExporter({ url: "https://example.test/v1/logs", headers }),
    }),
  ],
};
export const initialize: (
  config: MicrosoftOpenTelemetryBrowserOptions,
) => Promise<MicrosoftOpenTelemetryBrowser> = useMicrosoftOpenTelemetry;
// @ts-expect-error The previous distribution-specific option is no longer supported.
useMicrosoftOpenTelemetry({ samplingRatio: 1 });
// @ts-expect-error Service/resource configuration is not part of the supported options yet.
useMicrosoftOpenTelemetry({ serviceName: "consumer" });
// @ts-expect-error Upstream SDK controls are not exposed by the distro.
useMicrosoftOpenTelemetry({ disabled: true });
useMicrosoftOpenTelemetry({ session: { enabled: false } });
// @ts-expect-error Session timeouts remain internal fixed defaults.
useMicrosoftOpenTelemetry({ session: { inactivityTimeout: 60 } });
// @ts-expect-error Configure exporters through standard processors, not distro-specific options.
useMicrosoftOpenTelemetry({ otlp: { endpoint: "https://example.test" } });
// @ts-expect-error Configure exporters through standard processors, not upstream exportConfig.
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
