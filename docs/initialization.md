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
