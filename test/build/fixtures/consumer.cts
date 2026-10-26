import {
  AzureMonitorLogRecordExporter,
  AzureMonitorSpanExporter,
  OPENTELEMETRY_BROWSER_VERSION,
  useMicrosoftOpenTelemetry,
  type AzureMonitorOptions,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserConfigurationUpdate,
} from "@microsoft/opentelemetry-browser";
import { getInstrumentations } from "@microsoft/opentelemetry-browser/instrumentations";
// @ts-expect-error SDK stats types are internal.
import type { AzureMonitorSdkStatsOptions as _SdkStatsOptions } from "@microsoft/opentelemetry-browser";

void OPENTELEMETRY_BROWSER_VERSION;
void useMicrosoftOpenTelemetry;
void getInstrumentations;

export const options: AzureMonitorOptions = {
  connectionString: "InstrumentationKey=00000000-0000-0000-0000-000000000000",
  // @ts-expect-error SDK stats options are internal.
  sdkStats: {},
};
new AzureMonitorSpanExporter(options);
new AzureMonitorLogRecordExporter(options);
const asynchronousOptions: AzureMonitorOptions<Promise<string>> = {
  connectionString: Promise.resolve(options.connectionString),
};
useMicrosoftOpenTelemetry({ azureMonitor: options });
useMicrosoftOpenTelemetry({ azureMonitor: asynchronousOptions });
// @ts-expect-error Standalone trace exporters require a resolved connection string.
new AzureMonitorSpanExporter(asynchronousOptions);
// @ts-expect-error Standalone log exporters require a resolved connection string.
new AzureMonitorLogRecordExporter(asynchronousOptions);

useMicrosoftOpenTelemetry({ sessionRenewalMs: 60000, sessionExpirationMs: 120000 });
useMicrosoftOpenTelemetry({ sessionRenewalMs: undefined, sessionExpirationMs: undefined });
useMicrosoftOpenTelemetry({ session: { inactivityTimeout: 60, maxDuration: 120 } });
// @ts-expect-error Native initializer inactivity timeouts do not accept explicit undefined.
useMicrosoftOpenTelemetry({ session: { inactivityTimeout: undefined } });
// @ts-expect-error Native initializer maximum durations do not accept explicit undefined.
useMicrosoftOpenTelemetry({ session: { maxDuration: undefined } });
// @ts-expect-error Initializer renewal aliases use milliseconds as numbers.
useMicrosoftOpenTelemetry({ sessionRenewalMs: "60000" });
// @ts-expect-error Initializer expiration aliases use milliseconds as numbers.
useMicrosoftOpenTelemetry({ sessionExpirationMs: "120000" });

export async function updateSampling(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  const reset: MicrosoftOpenTelemetryBrowserConfigurationUpdate = {
    samplingPercentage: undefined,
  };
  await handle.updateCfg({});
  await handle.updateCfg({ samplingPercentage: 25 });
  await handle.updateCfg({ samplingPercentage: undefined });
  await handle.updateCfg(reset);
}

export async function updateSessionLifetimes(handle: MicrosoftOpenTelemetryBrowser): Promise<void> {
  const reset: MicrosoftOpenTelemetryBrowserConfigurationUpdate = {
    session: { inactivityTimeout: undefined, maxDuration: undefined },
    sessionRenewalMs: undefined,
    sessionExpirationMs: undefined,
  };
  await handle.updateCfg(reset);
  await handle.updateCfg({ session: undefined });
  await handle.updateCfg({ session: {} });
  await handle.updateCfg({ session: { inactivityTimeout: 0, maxDuration: 0 } });
  await handle.updateCfg({ sessionRenewalMs: 0, sessionExpirationMs: 0 });
  await handle.updateCfg({ session: { inactivityTimeout: undefined } });
  await handle.updateCfg({ session: { maxDuration: undefined } });
  await handle.updateCfg({ sessionRenewalMs: undefined });
  await handle.updateCfg({ sessionExpirationMs: undefined });
  await handle.updateCfg(
    { samplingPercentage: 25, sessionRenewalMs: 60000, sessionExpirationMs: 120000 },
    false,
  );
  // @ts-expect-error Runtime inactivity timeouts use seconds as numbers.
  await handle.updateCfg({ session: { inactivityTimeout: "60" } });
  // @ts-expect-error Runtime maximum durations use seconds as numbers.
  await handle.updateCfg({ session: { maxDuration: "120" } });
  // @ts-expect-error Runtime renewal aliases use milliseconds as numbers.
  await handle.updateCfg({ sessionRenewalMs: "60000" });
  // @ts-expect-error Runtime expiration aliases use milliseconds as numbers.
  await handle.updateCfg({ sessionExpirationMs: "120000" });
  // @ts-expect-error Session enablement is startup-only.
  await handle.updateCfg({ session: { enabled: false } });
  // @ts-expect-error Session persistence is startup-only.
  await handle.updateCfg({ session: { persist: false } });
  // @ts-expect-error Browser storage is startup-only.
  await handle.updateCfg({ storage: { enabled: false } });
}
