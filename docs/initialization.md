# Processor-backed initialization

`useMicrosoftOpenTelemetry(options)` initializes one trace pipeline and one log
pipeline using the upstream `BasicTracerProvider` and `LoggerProvider`. Applications
continue to use `@opentelemetry/api` and `@opentelemetry/api-logs` for manual telemetry.

Supply upstream processors, which can wrap any compatible exporter:

```typescript
import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor, InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { BatchLogRecordProcessor, InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { useMicrosoftOpenTelemetry } from "@microsoft/opentelemetry-distro-browser";

const spans = new InMemorySpanExporter();
const records = new InMemoryLogRecordExporter();
const telemetry = useMicrosoftOpenTelemetry({
  resource: resourceFromAttributes({ "service.name": "checkout", "service.version": "1.0.0" }),
  spanProcessors: [new BatchSpanProcessor(spans)],
  logRecordProcessors: [new BatchLogRecordProcessor({ exporter: records })],
});

const span = trace.getTracer("checkout").startSpan("checkout");
logs.getLogger("checkout").emit({
  eventName: "checkout.started",
  context: trace.setSpan(ROOT_CONTEXT, span),
});
span.end();
await telemetry.forceFlush();

// Inspect in-memory exports before shutdown, which clears these upstream exporters.
const finishedSpans = spans.getFinishedSpans();
const finishedRecords = records.getFinishedLogRecords();
await telemetry.shutdown();
```

## Configuration and ownership

- Distribution options are validated before global registration: the options
  object, supported option names, sampling ratio, and processor-list containers.
- Processors, resources, and propagators are expected to satisfy their upstream
  OpenTelemetry interfaces. The distribution does not revalidate their methods or
  internal settings; invalid implementations may fail when the SDK uses them.
- `azureMonitor` and `otlp` presets currently throw instead of silently ignoring
  destination settings. Instrumentation and session configuration are not implemented.
- Omitting both processor lists is valid but emits an upstream `diag.warn` because
  nothing will be exported. A single-signal configuration is also supported.
- Processor arrays are copied when building the providers. Resources and processors
  are not frozen or cloned, and processors are owned only after successful initialization.
- The default resource contains upstream service and SDK attributes plus
  `telemetry.distro.name` and `telemetry.distro.version`. Caller attributes win when
  merged. Automatic browser detection remains in the separate browser detector work.
- `samplingRatio` defaults to `1` and applies to root traces through an upstream
  parent-based ratio sampler. Existing parent sampling decisions are honored; logs
  are not sampled.
- Propagation defaults to W3C Trace Context and Baggage. A custom upstream
  propagator replaces that default. No fetch/XHR instrumentation or context manager
  is installed; pass explicit Context values for parenting and correlation, including
  across `await`. An application-provided context manager is left untouched.
- Only one initialization may be active in a realm. Existing required global
  registrations cause initialization to fail rather than being overwritten.
  Do not replace these globals while the handle owns them.

## Lifecycle

`forceFlush()` delegates to both providers and serializes calls using their returned promises.
Each provider uses its upstream 30-second processor flush timeout. Both providers
are attempted, and failures are reported in an `AggregateError`; entries retain
the original upstream rejection values.

Failure timing follows the upstream SDK: a provider can reject while other processors
inside that provider are still running. The distribution does not collect individual
processor failures or wait for those siblings after the provider has rejected.

`shutdown()` immediately stops forwarding new telemetry and late-ending spans to
processors. It waits for queued provider flush calls to settle, unregisters owned
globals, and delegates shutdown to both providers. Repeated shutdown calls return
the same promise and result. Flush calls after shutdown begins return that promise
without restarting work. There is no additional distribution-level shutdown
timeout: completion depends on the supplied processors. A new instance can be
initialized once shutdown settles; do not reuse processors owned by the old instance.

No distribution-owned page-lifecycle listeners or automatic instrumentation are
installed. Supplied upstream batch processors retain their own batching and
page-lifecycle behavior. More extensive lifecycle diagnostics are separate work.

## Packaging

The npm ESM output keeps OpenTelemetry dependencies external to share the
application's API instances and use the consumer's platform resolution.
The minified ESM browser bundle includes the upstream SDKs. This initial combined
entry point includes both signals; separate signal entry points remain future work.
