# @microsoft/opentelemetry-browser

[![Status](https://img.shields.io/badge/status-proposed-orange)](planning/IMPLEMENTATION_PLAN.md)
[![Milestone](https://img.shields.io/badge/beta-9%20October-blue)](planning/M0_WORK_BREAKDOWN.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Microsoft OpenTelemetry distribution for browser applications — one import, one call, page views,
exceptions, fetch/XHR tracing and manual telemetry across Azure Monitor and OTLP-compatible
backends.

This is the browser sibling of the Microsoft distributions for
[Node.js](https://github.com/microsoft/opentelemetry-distro-javascript) and
[Python](https://github.com/microsoft/opentelemetry-distro-python).

> **Not published yet.** This repository currently holds the implementation plan and a
> working proof of concept. The package name is provisional and the beta is targeted for
> **9 October**. Everything below describes the surface being built — see
> [`planning/`](planning/).

## Getting Started

### Prerequisites

- A modern browser — ES2022, ESM. See [Supported environments](#supported-environments).
- An [Application Insights resource](https://learn.microsoft.com/azure/azure-monitor/app/app-insights-overview)
  (optional, for Azure Monitor), or any OTLP-compatible endpoint.

### Install the package

```bash
npm install @microsoft/opentelemetry-browser
```

### Quick start

Call `useMicrosoftOpenTelemetry()` as early as possible in your application entry point, before the
code you want instrumented runs.

**Azure Monitor:**

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry-browser";

useMicrosoftOpenTelemetry({
  azureMonitor: {
    connectionString: "InstrumentationKey=...;IngestionEndpoint=...",
  },
});
```

**OTLP:**

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry-browser";

useMicrosoftOpenTelemetry({
  otlp: {
    endpoint: "https://collector.example.com:4318",
  },
});
```

That's it — page views, SPA soft navigations, unhandled errors and promise rejections, and fetch/XHR
spans with W3C trace context are collected automatically, with `session.id` and document context on
both signals.

### Manual telemetry

Use the standard upstream OpenTelemetry APIs. The distribution never asks you to learn a proprietary
telemetry API, so instrumented code stays valid OpenTelemetry.

```typescript
import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

const tracer = trace.getTracer("my-app", "1.0.0");
const span = tracer.startSpan("checkout");
span.setAttribute("cart.item_count", 3);
span.end();

logs.getLogger("my-app", "1.0.0").emit({
  eventName: "app.checkout_started",
  attributes: { "cart.item_count": 3 },
});
```

Browser occurrences are **log records carrying a top-level `eventName`**; spans are reserved for
operations with real duration and backend correlation. See
[§2 of the plan](planning/IMPLEMENTATION_PLAN.md#2-product-principles).

### Flush and shutdown

Telemetry is batched and flushed automatically on `pagehide` and `visibilitychange`. The handle
returned by `useMicrosoftOpenTelemetry()` lets you do it explicitly:

```typescript
const telemetry = useMicrosoftOpenTelemetry({ /* ... */ });

await telemetry.forceFlush();
await telemetry.shutdown();
```

## Configuration

### `MicrosoftOpenTelemetryBrowserOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `azureMonitor` | `AzureMonitorOptions` | — | Azure Monitor destination. When provided, Azure Monitor export is enabled |
| `otlp` | `OtlpOptions` | — | OTLP/HTTP destination for traces and logs |
| `resource` | `Resource` | default resource | OpenTelemetry Resource. Add `browserDetector` or `userAgentDetector` to attach browser attributes |
| `samplingRatio` | `number` | `1.0` | Ratio of traces to sample (0.0–1.0) |
| `instrumentationOptions` | `InstrumentationOptions` | see below | Toggle built-in instrumentations |
| `spanProcessors` | `SpanProcessor[]` | — | Additional upstream span processors |
| `logRecordProcessors` | `LogRecordProcessor[]` | — | Additional upstream log record processors |
| `propagator` | `TextMapPropagator` | W3C Trace Context + Baggage | Context propagator |
| `propagateToUrls` | `(string \| RegExp)[]` | same origin | Allow list for outbound `traceparent` injection |
| `session` | `SessionOptions` | 30 min timeout | Session ID generation, storage, timeout and renewal |

Configuration is validated and normalized into an immutable snapshot before any global is registered
or any browser API is patched. Upstream types are passed through rather than re-modelled.

### `azureMonitor` options

| Option | Type | Default | Description |
|---|---|---|---|
| `connectionString` | `string` | — | Application Insights connection string, including sovereign clouds |
| `disableBeacon` | `boolean` | `false` | Disable the `sendBeacon` fallback used on page unload |

### `otlp` options

| Option | Type | Default | Description |
|---|---|---|---|
| `endpoint` | `string` | — | Base OTLP/HTTP endpoint |
| `headers` | `Record<string, string>` | — | Additional headers on export requests |

### `instrumentationOptions`

Instrumentations are named by the occurrence they capture, not by the package that produces them,
and each is individually enableable and individually importable — so an events-only consumer never
pays for the tracing SDK and vice versa.

```typescript
useMicrosoftOpenTelemetry({
  azureMonitor: { connectionString: "..." },
  instrumentationOptions: {
    pageView: { enabled: true },
    exception: { enabled: true },
    fetch: { enabled: false },
    xmlHttpRequest: { enabled: false },
  },
});
```

## Bundle size

Bundle size is the binding constraint for a browser distribution, so it is measured on every build
rather than argued about. From [`poc/SIZE_REPORT.md`](poc/SIZE_REPORT.md), gzipped:

| Layer | Gzip |
|---|---:|
| OpenTelemetry API only (trace + logs) | 3.70 KB |
| + SDK (providers, batch processors, W3C propagators) | 19.56 KB |
| + multi-instance bridge | 21.29 KB |
| + all 9 instrumentations and both OTLP exporters | 41.50 KB |

For comparison, Application Insights v3 ships 71.3 KB gzipped and Splunk's OpenTelemetry browser
distribution 140.5 KB. The per-package deltas, and why per-package numbers must never be summed,
are in [`poc/SIZE_REPORT.md`](poc/SIZE_REPORT.md), regenerated by `npm run size`.

## Supported environments

| Runtime | Support |
|---|---|
| ES2022+ browsers (current Chrome, Edge, Firefox, Safari) | Full distribution |
| ES2015 to pre-ES2020 browsers | Capability-detecting loader, planned |
| Pre-ES2015 browsers | Not supported; separate no-op package, planned |

The package is ESM-only with an `exports` map and no `main`/`module` fields. Not shipping ES5 is the
single largest bundle-size lever available, so legacy runtimes are handled by a loader rather than by
downleveling the main bundle.

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit
[Contributor License Agreements](https://cla.opensource.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a
CLA and decorate the pull request appropriately. You only need to do this once across repositories
using this CLA.

This project has adopted the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more
information, see the
[Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact
[opencode@microsoft.com](mailto:opencode@microsoft.com).

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of
Microsoft trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion
or imply Microsoft sponsorship. Any use of third-party trademarks or logos is subject to those third
parties' policies.
