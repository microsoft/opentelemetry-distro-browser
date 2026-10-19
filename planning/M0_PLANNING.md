# Milestone M0 - Planning

Ship a thin distribution: configure the upstream `@opentelemetry/browser-sdk`, add a browser-native
Azure Monitor exporter, adopt the upstream browser instrumentations, and publish. M0 is
single-instance and ES2022 ESM-only, and does not build its own SDK.

Status: beta published. `0.1.0-beta.1` is the npm `latest` release and is on the CDN at
`js.monitor.azure.com/scripts/otel/beta/` (#125). The items below remain.

## Remaining

| Item | Description |
| --- | --- |
| Semconv barrel lint | ESLint `no-restricted-imports` banning barrel imports from `@opentelemetry/semantic-conventions`, permitting the individual `ATTR_*`/`METRIC_*` constants |
| Beta validation | End-to-end validation of `0.1.0-beta.1` against a real Application Insights resource, with the result recorded before sign-off |
| Release notes correction | The `0.1.0-beta.1` changelog lists minimum supported browser versions with acceptance tests. That work was reverted (#102) and the README still states a latest-stable policy, so the entry must be corrected |
| npm dist-tags | The `alpha` dist-tag still points to `0.1.0-alpha.2` rather than `0.1.0-alpha.3`, and no `beta` dist-tag exists |

## Shipped

| Item | Description |
| --- | --- |
| Initialization surface | One `useMicrosoftOpenTelemetry(options)` call returning a per-call handle |
| Handle lifecycle | `forceFlush()` and idempotent `shutdown()` across both pipelines |
| Page-lifecycle flush | Distribution-owned flush on `pagehide` and `visibilitychange` |
| Resource customization | `resource?: Resource` option (#30) |
| Context and propagation config | `traces.{contextManager, propagators}` (#27) |
| Resource detectors | Browser and user-agent detectors, opt-in (#8), npm only since #117 removed them from the CDN bundles |
| Session management | `session.enabled` (#23), on by default since #124 |
| Azure Monitor exporters | Span and log record exporters wired through `azureMonitor.connectionString` (#28) |
| SDK version tag | `ai.internal.sdkVersion` emitted as `mot<version>` (#26) |
| Breeze transport | Retry, backoff and throttle handling (#24) |
| Trusted redirects | Redirect handling (#22) |
| Compression | gzip request compression (#20) |
| Unload delivery | `sendBeacon` fallback (#16), payload limits and tests (#34), unload batches fitted to the keepalive and Beacon limits (#88), queued logs delivered during navigation with a pending export (#101) |
| Page views | Page view instrumentation, on by default (#17), with page view ID and referrer mapping (#39) |
| Page correlation | Page views, spans and logs share operation IDs (#29) |
| Exception stacks | `parsedStack` frames on exception telemetry (#41) |
| Self-telemetry loop guard | Azure Monitor export requests suppress tracing so `fetch` instrumentation does not capture them (#59) |
| Flush coalescing | Concurrent `forceFlush()` calls share one operation (#43) |
| Ingestion fixes | Empty message bodies populated (#50); HTTPS required for non-loopback endpoints (#74); empty connection string fields ignored (#75); duplicate export callbacks fixed (#87); `EventData` classification fixed (#92) |
| Retry bounds | A 30-second retry-wait budget keeps long `Retry-After` values from stalling `forceFlush()` and `shutdown()` (#76) |
| Instrumentation entry point | `getInstrumentations()` on `./instrumentations`, each module dynamically imported (#21) |
| Size harness | `scripts/measure-bundle-size.mjs` (#37), scenario trends (#49), per-entry-point budgets reported during alpha (#52) |
| Root bundle budget | Default OTLP exporters removed (#117) and the root budget re-approved at 121 KiB minified (#125). Budgets are blocking from beta |
| Beta documentation | Configuration reference, event catalogue and beta release notes (#131); TypeDoc API reference on GitHub Pages (#113) |
| PR performance harness | Pull-request performance regression reporting and comparison (#38) |
| Changelog check | CI changelog gate (#35) |
| Test coverage | End-to-end page view and custom event (#32), context handling (#33), shared fixtures and PR coverage reports (#51) |
| Release | First alpha published, package renamed (#31, #36); `0.1.0-alpha.2` (#79), `0.1.0-alpha.3` (#90) and `0.1.0-beta.1` (#125) published |
| Public-release paperwork | `LICENSE`, `NOTICE.md`, `SECURITY.md`, `SUPPORT.md`, `PRIVACY.md`, `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md` |

## Deferred

- Remaining upstream instrumentation modules (`navigation-timing`, `resource-timing`, `web-vitals`,
  `user-action`, `console`) stay constructible but opt-in.
- Offline persistence is owned by [M3](M3_PLANNING.md).
- Further tree-shaking verification and size tuning against the blocking budgets in
  [M1](M1_PLANNING.md).
- Package provenance and signing, and a release runbook covering rollback, deprecation and hotfix.
- Flake policy and CI retry/quarantine behaviour for browser tests.
- End-to-end validation in the partner application against their own Application Insights resource
  and browser matrix, plus a telemetry volume and cost review. Owned outside this repository.

Resolved: page view performance telemetry is emitted from the distribution's page view
instrumentation and mapped by the Azure Monitor exporter (#58), not built on the upstream
`navigation-timing` module.
