# Initialization

The distribution directly re-exports the experimental
[`@opentelemetry/browser-sdk`](https://github.com/open-telemetry/opentelemetry-browser/tree/main/packages/sdk),
pinned to `0.4.0`. It does not construct providers or implement its own lifecycle.

## Choose an initializer

Import these functions from `@microsoft/opentelemetry-distro-browser`:

| Function                          | Upstream function | Signals         |
| --------------------------------- | ----------------- | --------------- |
| `useMicrosoftOpenTelemetry`       | `startBrowserSdk` | Traces and logs |
| `useMicrosoftOpenTelemetryTraces` | `startTracesSdk`  | Traces only     |
| `useMicrosoftOpenTelemetryLogs`   | `startLogsSdk`    | Logs only       |

The signal-specific functions use upstream's `/traces` and `/logs` modules.
A tree-shaking ESM bundler can remove the unused signal. Native imports without
tree shaking still load both signals from the root entry.

## Example

```typescript
import { useMicrosoftOpenTelemetryTraces } from "@microsoft/opentelemetry-distro-browser";
import { trace } from "@opentelemetry/api";

const telemetry = useMicrosoftOpenTelemetryTraces({
  serviceName: "checkout",
  exportConfig: { url: "https://collector.example.com/v1/traces" },
});

trace.getTracer("checkout").startSpan("checkout").end();
await telemetry.shutdown();
```

For logs only, use `useMicrosoftOpenTelemetryLogs` with a `/v1/logs` endpoint.
For both, use `useMicrosoftOpenTelemetry` with a base `exportConfig.url` and
optional `traces` and `logs` configuration objects.

## Configuration and lifecycle

- Configuration types are aliases of the upstream types. Use `resourceAttributes`,
  `processors`, `sampler`, and `propagators`, not the previous distribution options.
  In combined configuration, put processors under `traces.processors` and
  `logs.processors`. Azure Monitor connection-string configuration is not provided.
- Upstream supplies OTLP exporters and batch processors when processors are omitted,
  defaulting to `http://localhost:4318`. Supplying processors suppresses the default
  exporter unless `exportConfig` is also set. Empty processor arrays without
  `exportConfig` log an error and leave that signal inactive; unknown JavaScript
  options are not validated here.
- Tracing installs upstream's synchronous context manager and default W3C Trace
  Context/Baggage propagation. It does not patch async context or instrument requests.
- The returned handle has **`shutdown()` only**, not `forceFlush()`. When needed,
  flush processors you supplied directly before shutdown.
- Shutdown behavior and errors are upstream's. Version `0.4.0` does not unregister
  global providers, propagation, or context, and this distribution adds no
  single-instance guard, transactional rollback, or restart guarantee. Initialize
  once in a browser context; do not assume shutdown permits safe reinitialization.

Upstream defaults also control diagnostics and resource attributes; no extra
distribution attributes or custom stale-handle guards are added.
See [packaging](packaging.md) for build outputs.
