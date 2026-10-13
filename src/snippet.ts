// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { OPENTELEMETRY_BROWSER_VERSION } from "./shared/constants.js";

/**
 * Configuration for {@link getSdkLoaderScript}.
 *
 * @public
 */
export interface SdkLoaderConfig {
  /**
   * URL of a classic script that exposes
   * `Microsoft.OpenTelemetry.useMicrosoftOpenTelemetry` on `window`, such as the package's
   * `opentelemetry-browser.iife.min.js` bundle.
   *
   * @remarks
   * Defaults to this package version's immutable CDN bundle,
   * `https://js.monitor.azure.com/scripts/otel/<channel>/opentelemetry-browser.<version>.min.js`,
   * where the channel is `b` for stable releases and the prerelease identifier, such as `alpha`,
   * otherwise. The package's ESM output is not compatible with this loader. A UMD bundle only
   * sets the global when no AMD loader is present.
   */
  readonly src?: string;
  /** Azure Monitor connection string passed to the distribution initializer. */
  readonly connectionString: string;
  /** `crossorigin` value applied to the injected script. Defaults to `anonymous`. */
  readonly crossOrigin?: string;
  /** Subresource Integrity metadata applied to the injected script. */
  readonly integrity?: string;
  /**
   * Milliseconds to wait before adding the bundle's script element, like the Application
   * Insights loader's `ld`. Omit to add it immediately.
   */
  readonly loadDelay?: number;
  /**
   * Retries a bundle that fails to load from each backup Azure Monitor CDN host in turn, like the
   * Application Insights loader's `cr`. Requires `src` on an Azure Monitor CDN host, which
   * includes the default. Allow the backup hosts in a Content Security Policy's `script-src`.
   */
  readonly cdnFallback?: boolean;
  /**
   * Sends an `SDKLoadFailed` exception to the connection string's ingestion endpoint when the
   * bundle fails to load, after any CDN fallback, so missing telemetry is visible in Azure Monitor.
   */
  readonly reportLoadFailure?: boolean;
  /**
   * Fixed percentage of traces and Azure Monitor log records retained, from 0 through 100.
   * Same as `MicrosoftOpenTelemetryBrowserOptions.samplingPercentage`.
   */
  readonly samplingPercentage?: number;
  /** Azure Monitor export settings other than the connection string. */
  readonly azureMonitor?: {
    /** Same as `AzureMonitorOptions.disableBeacon`. */
    readonly disableBeacon?: boolean;
  };
  /** Same as `MicrosoftOpenTelemetryBrowserOptions.session`. */
  readonly session?: {
    readonly enabled?: boolean;
    readonly persist?: boolean;
    readonly inactivityTimeout?: number;
    readonly maxDuration?: number;
  };
  /** Same as `MicrosoftOpenTelemetryBrowserOptions.userContext`. */
  readonly userContext?: { readonly enabled?: boolean };
  /** The data-only settings of `MicrosoftOpenTelemetryBrowserOptions.pageView`. */
  readonly pageView?: {
    readonly enabled?: boolean;
    readonly redactedQueryParams?: readonly string[];
    readonly softNavigationSettleTimeoutMs?: number;
    readonly useNavigationApiIfAvailable?: boolean;
  };
  /**
   * Options the loader passes to the bundle's `getInstrumentations`, keyed by instrumentation
   * name, such as `{ errors: { enabled: true } }`. Omit to enable the defaults, `fetch` and `xhr`.
   *
   * @remarks
   * Named after `instrumentationOptions` in the Node.js distribution, because
   * `MicrosoftOpenTelemetryBrowserOptions.instrumentations` holds constructed instances. Only
   * JSON-serializable settings are accepted, so hooks and regular expressions are unavailable.
   */
  readonly instrumentationOptions?: {
    readonly [name: string]: SdkLoaderJsonObject & { readonly enabled?: boolean };
  };
  /**
   * Resource attributes, such as `service.name`, merged over the SDK defaults. The bundle builds
   * the resource with its `resourceFromAttributes`.
   */
  readonly resourceAttributes?: { readonly [key: string]: string | number | boolean };
}

/**
 * A JSON value the loader inlines into its configuration.
 *
 * @public
 */
export type SdkLoaderJsonValue =
  string | number | boolean | null | readonly SdkLoaderJsonValue[] | SdkLoaderJsonObject;

/**
 * A JSON object the loader inlines into its configuration.
 *
 * @public
 */
export interface SdkLoaderJsonObject {
  /** A JSON value; undefined members are omitted. */
  readonly [key: string]: SdkLoaderJsonValue | undefined;
}

/** Hosts that serve the same CDN files, primary first. */
const cdnHosts = [
  "js.monitor.azure.com",
  "js.cdn.applicationinsights.io",
  "js.cdn.monitor.azure.com",
  "js0.cdn.applicationinsights.io",
  "js0.cdn.monitor.azure.com",
  "js2.cdn.applicationinsights.io",
  "js2.cdn.monitor.azure.com",
];

/** Resolves the ingestion endpoint the way the exporter's connection string parser does. */
const getTrackUrl = (connectionString: string): { url: string; iKey?: string } => {
  const fields: Record<string, string> = {};
  for (const field of connectionString.split(";")) {
    const separator = field.indexOf("=");
    fields[field.slice(0, separator).trim().toLowerCase()] = field.slice(separator + 1).trim();
  }
  const suffix = fields.endpointsuffix;
  const endpoint =
    fields.ingestionendpoint ||
    (suffix
      ? `https://${fields.location ? `${fields.location}.` : ""}dc.${suffix}`
      : "https://dc.services.visualstudio.com");
  return { url: `${endpoint.replace(/\/+$/, "")}/v2/track`, iKey: fields.instrumentationkey };
};

const loadFailure = "OpenTelemetry browser bundle failed to load: ";

const defaultSrc = (): string =>
  `https://js.monitor.azure.com/scripts/otel/${
    /^[^-+]+-([a-z]+)/.exec(OPENTELEMETRY_BROWSER_VERSION)?.[1] ?? "b"
  }/opentelemetry-browser.${OPENTELEMETRY_BROWSER_VERSION}.min.js`;

const inlineJson = (value: unknown): string =>
  JSON.stringify(value).replace(/[<>\u2028\u2029]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003c";
      case ">":
        return "\\u003e";
      case "\u2028":
        return "\\u2028";
      default:
        return "\\u2029";
    }
  });

const isObject = (value: unknown): value is object => {
  const prototype: unknown =
    typeof value === "object" && value ? Object.getPrototypeOf(value) : undefined;
  return prototype === Object.prototype || prototype === null;
};

const isPrimitive = (value: unknown): boolean =>
  typeof value === "string" || typeof value === "boolean" || Number.isFinite(value);

/** Rejects values `JSON.stringify` would drop or alter, such as functions and regular expressions. */
const isJson = (value: unknown): boolean =>
  value === null ||
  isPrimitive(value) ||
  (Array.isArray(value)
    ? value.every(isJson)
    : isObject(value) && Object.values(value).every((item) => item === undefined || isJson(item)));

const check = (valid: unknown, name: string, expected: string): void => {
  if (!valid) throw new TypeError(`SdkLoaderConfig.${name} must be ${expected}.`);
};

const isNonEmptyString = (value: unknown): boolean =>
  typeof value === "string" && value.trim() !== "";

/**
 * Creates an inline loader that downloads the browser bundle and starts Azure Monitor telemetry.
 *
 * @remarks
 * The generated script exposes initialization as `window.microsoftOpenTelemetry`, a promise that
 * resolves to the distribution lifecycle handle and rejects when the bundle fails to load or
 * initialize. Without `src`, it loads this package version's bundle from the CDN; supply the
 * matching `integrity` value from the release's `integrity.json` to verify it.
 *
 * When the loaded bundle exposes `getInstrumentations`, as the package's browser bundles do, the
 * loader passes it `instrumentationOptions`, which by default enables `fetch` and `xhr` alongside
 * page views. The other options are inlined as JSON and passed to `useMicrosoftOpenTelemetry`
 * unchanged, except `resourceAttributes`, which the bundle's `resourceFromAttributes` turns into
 * the `resource` option.
 *
 * @throws TypeError when an option has the wrong type or is not JSON-serializable.
 *
 * @public
 */
export function getSdkLoaderScript(config: SdkLoaderConfig): string {
  const src = config?.src === undefined ? defaultSrc() : config.src;
  const optional = "when provided";
  check(isNonEmptyString(src), "src", `a non-empty string ${optional}`);
  check(isNonEmptyString(config?.connectionString), "connectionString", "a non-empty string");
  const { samplingPercentage, azureMonitor, instrumentationOptions, resourceAttributes } = config;
  check(
    config.integrity === undefined || isNonEmptyString(config.integrity),
    "integrity",
    `a non-empty string ${optional}`,
  );
  check(
    samplingPercentage === undefined ||
      (typeof samplingPercentage === "number" &&
        samplingPercentage >= 0 &&
        samplingPercentage <= 100),
    "samplingPercentage",
    `a number from 0 through 100 ${optional}`,
  );
  for (const name of [
    "azureMonitor",
    "session",
    "userContext",
    "pageView",
    "instrumentationOptions",
    "resourceAttributes",
  ] as const) {
    const value = config[name];
    check(
      value === undefined || (isObject(value) && isJson(value)),
      name,
      `a JSON object ${optional}`,
    );
  }
  check(
    [undefined, true, false].includes(azureMonitor?.disableBeacon),
    "azureMonitor.disableBeacon",
    `a boolean ${optional}`,
  );
  const { loadDelay, cdnFallback, reportLoadFailure } = config;
  check(
    loadDelay === undefined || (Number.isFinite(loadDelay) && loadDelay >= 0),
    "loadDelay",
    `a nonnegative number ${optional}`,
  );
  check([undefined, true, false].includes(cdnFallback), "cdnFallback", `a boolean ${optional}`);
  check(
    [undefined, true, false].includes(reportLoadFailure),
    "reportLoadFailure",
    `a boolean ${optional}`,
  );
  const host = /^https:\/\/([^/]+)\//.exec(src)?.[1] ?? "";
  check(
    !cdnFallback || cdnHosts.includes(host),
    "src",
    "on an Azure Monitor CDN host for cdnFallback",
  );
  const report = reportLoadFailure ? getTrackUrl(config.connectionString) : undefined;
  check(
    Object.values(resourceAttributes ?? {}).every(isPrimitive),
    "resourceAttributes",
    "an object of strings, numbers and booleans",
  );

  // `cfg` is passed to `useMicrosoftOpenTelemetry` as is; undefined options are dropped.
  const serialized = inlineJson({
    src,
    crossOrigin: config.crossOrigin ?? "anonymous",
    integrity: config.integrity,
    cfg: {
      azureMonitor: { ...azureMonitor, connectionString: config.connectionString },
      samplingPercentage,
      session: config.session,
      userContext: config.userContext,
      pageView: config.pageView,
    },
    instrumentationOptions,
    resourceAttributes,
    loadDelay,
    fallbackHosts: cdnFallback ? cdnHosts.filter((candidate) => candidate !== host) : undefined,
    loadFailureReport: report && {
      url: report.url,
      envelope: {
        name: "Microsoft.ApplicationInsights.Exception",
        iKey: report.iKey,
        tags: { "ai.internal.sdkVersion": `browser:snippet:mot${OPENTELEMETRY_BROWSER_VERSION}` },
        data: {
          baseType: "ExceptionData",
          baseData: {
            ver: 2,
            exceptions: [{ typeName: "SDKLoadFailed", message: loadFailure, hasFullStack: false }],
          },
        },
      },
    },
  });
  // Optional loader steps are emitted only when configured, keeping the default snippet small.
  const fallback = cdnFallback
    ? 'var h=c.fallbackHosts.shift();if(h)return l(u.replace(/\\/\\/[^/]+/,"//"+h));'
    : "";
  const reportFailure = report
    ? 'try{var r=c.loadFailureReport,e=r.envelope;e.time=new Date().toISOString();e.data.baseData.exceptions[0].message+=u;fetch(r.url,{method:"POST",keepalive:true,body:JSON.stringify([e])}).catch(function(){})}catch(x){}'
    : "";
  const start =
    loadDelay === undefined ? "l(c.src)" : "setTimeout(function(){l(c.src)},c.loadDelay)";
  return `!(function(w,d,c){w.microsoftOpenTelemetry=new Promise(function(resolve,reject){function l(u){var s=d.createElement("script");s.src=u;s.crossOrigin=c.crossOrigin;if(c.integrity)s.integrity=c.integrity;s.onload=function(){var sdk=w.Microsoft&&w.Microsoft.OpenTelemetry;if(!sdk||typeof sdk.useMicrosoftOpenTelemetry!=="function"){reject(new Error("OpenTelemetry browser bundle did not expose Microsoft.OpenTelemetry"));return}Promise.resolve().then(function(){return typeof sdk.getInstrumentations==="function"?sdk.getInstrumentations(c.instrumentationOptions):[]}).then(function(i){var o=c.cfg;o.instrumentations=i;if(c.resourceAttributes)o.resource=sdk.resourceFromAttributes(c.resourceAttributes);return sdk.useMicrosoftOpenTelemetry(o)}).then(resolve,reject)};s.onerror=function(){${fallback}${reportFailure}reject(new Error("${loadFailure}"+u))};d.head.appendChild(s)}${start}})})(window,document,${serialized});`;
}
