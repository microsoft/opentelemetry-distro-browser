# Initialization

`useMicrosoftOpenTelemetry()` directly re-exports `startBrowserSdk` from the experimental
[`@opentelemetry/browser-sdk`](https://github.com/open-telemetry/opentelemetry-browser/tree/main/packages/sdk),
pinned to `0.4.0`. It does not construct providers or implement its own lifecycle.

There is one initializer for traces and logs together. Both SDKs are included when
the initializer is used; there are no signal-specific initializers or per-signal
disable flags.

## Example

```typescript
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry-distro-browser";
import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

const telemetry = useMicrosoftOpenTelemetry({
  serviceName: "checkout",
  exportConfig: { url: "https://collector.example.com" },
});

trace.getTracer("checkout").startSpan("checkout").end();
logs.getLogger("checkout").emit({ eventName: "checkout.started" });
await telemetry.shutdown();
```

Use a base `exportConfig.url`; upstream adds `/v1/traces` and `/v1/logs`.
Optional `traces` and `logs` objects configure each signal's processors and settings.
