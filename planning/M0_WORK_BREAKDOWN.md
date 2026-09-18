# Milestone M0 - Work Items

The work for Milestone M0, introduced in Section 6 of the
[implementation plan](IMPLEMENTATION_PLAN.md).

M0 composes upstream OpenTelemetry packages, adds a browser-native Azure Monitor
exporter, and adopts upstream browser instrumentation. It does not build our own
SDK - the multi-instance provider and per-instance lifecycle proven in
[`poc/`](../poc/) are M2 onward. It is single-instance and ES2022 ESM-only.

Each bullet below is one task. Its sub-bullets are the checklist that goes in the
task description. Items marked **Follow-up** are out of M0.

Tasks are grouped into four phases:

| Phase | Areas |
|---|---|
| **P1 Setup** | Repository, build, and tooling; test frameworks |
| **P2 Build** | Distribution core; exporter; instrumentation; tracing |
| **P3 Harden** | Bundle size; release pipeline; legal and compliance |
| **P4 Ship** | Documentation and publication; Rayfin end-to-end validation |

---

## Repository, build, and tooling

- **Confirm the beta requirements with Rayfin.**
  - Occurrence set, destination, browser support matrix, integration model.
  - Confirm explicitly that single-instance and ES2022/modern-browser-only are
    acceptable for the beta.
- **Stand up the workspace and build.**
  - Package boundaries: distribution core, Azure Monitor exporter, web analytics
    instrumentation, test utilities.
  - TypeScript at ES2022. ESM-only output with `exports` maps, no
    `main`/`module`, declaration and sourcemap emit.
  - Pin exact upstream OpenTelemetry versions including the `0.x` logs line, and
    document the pins and the upgrade policy.
  - Shared lint and format configuration.
- **Set up CI and dependency governance.**
  - Build, lint, unit tests and browser tests on every pull request, with branch
    protection.
  - Component Governance, automated dependency updates, license scanning on every
    build.
- **Set up API surface review.**
  - API Extractor or equivalent producing a reviewed API report, with a CI gate
    on unreviewed public API changes.
  - The beta surface is the compatibility commitment, so it is reviewed before it
    ships.

## Test frameworks and harnesses

- **Stand up the test runners.**
  - Unit test runner with coverage reporting and an initial threshold.
  - Playwright browser harness with the existing PoC fixtures ported across.
  - Browser matrix (Chromium, Firefox, WebKit, Edge) against the confirmed
    support matrix.
- **Build the test fixtures.**
  - Mock Azure Monitor ingestion endpoint asserting envelope shape without a
    network dependency.
  - Shared utilities: in-memory exporters, fake clock, deterministic session and
    ID generation.
- **Follow-up.** Flake policy and CI retry/quarantine behavior for browser tests.

## Distribution core and initialization surface

- **Define the public initialization surface.**
  - One `initialize(config)` returning a handle, with configuration passed
    through to upstream rather than re-modelled.
  - Confirm a single instance is the degenerate case of the M2 instance model -
    confirm only, build nothing for it.
- **Implement initialization.**
  - Construct the upstream tracer provider, logger provider, processors and
    exporters from configuration.
  - Assemble the resource from upstream semantic conventions plus service, SDK
    and browser attributes.
  - Configure upstream `BatchSpanProcessor` and `BatchLogRecordProcessor` with
    browser-appropriate defaults.
- **Implement lifecycle and diagnostics.**
  - Page-lifecycle flush on `pagehide`/`visibilitychange`.
  - `forceFlush()` and `shutdown()` on the handle, delegating to both upstream
    providers and idempotent across them.
  - Diagnostics through the upstream `diag` API, including visibility into
    dropped or rejected telemetry.
- **Test the core.**
  - Unit and browser tests for initialization, flush, shutdown and configuration
    pass-through.
- **Follow-up.** Detect and report a pre-existing global OTel SDK registration
  without overwriting it.

## Azure Monitor browser exporter

A new browser exporter written in this repository. Neither existing
implementation can be depended on: `@azure/monitor-opentelemetry-exporter` is
Node-only (`package.json` declares no `browser` field, `src/platform/` contains
only `nodejs/`, and it depends on `@azure/core-rest-pipeline`,
`@azure/core-client`, `@azure-rest/core-client` and `@azure/core-process`), and
`ApplicationInsights-JS` is a browser SDK with its own telemetry model rather
than an OTel exporter. Both are first-party and are used as references.

| Concern | Reference |
|---|---|
| OTel span and log record to envelope mapping | `@azure/monitor-opentelemetry-exporter` (`spanUtils`, `logUtils`) |
| Envelope shape and field names | Both |
| Connection string and sovereign cloud endpoints | Both |
| Browser transport: `fetch`, `sendBeacon`, unload behavior | `ApplicationInsights-JS` sender |
| Breeze response codes, retry, backoff, throttle, redirect | Both |
| PageView and CustomEvent envelopes | `ApplicationInsights-JS` - no equivalent in the Node exporter |

- **Spike the browser ingestion path.**
  - CORS preflight, `keepalive` payload limits, `sendBeacon` size caps, gzip
    support.
- **Implement the envelope mapping.**
  - Envelope types and the connection string parser, including sovereign clouds.
  - Span exporter: `ReadableSpan` to envelope, including attribute, status and
    duration mapping.
  - Log record exporter: log record with `eventName` to envelope, including
    severity and attribute mapping.
  - PageView and CustomEvent envelopes.
- **Implement the browser sender.**
  - `fetch` with `keepalive`, `sendBeacon` fallback on page unload, payload size
    limits, gzip if supported.
  - Retry, backoff, throttle and redirect handling per the ingestion response
    contract.
- **Test and measure the exporter.**
  - Unit tests for mapping and transport, plus a browser test exporting end to
    end against the mock ingestion endpoint.
  - Cross-check envelope output against the two reference implementations.
  - Measure the standalone gzipped size and assert no `@azure/core-*` package is
    reachable from the bundle.
- **Follow-up.** Sampling field and instrumentation key population on the
  envelope.

Out of M0: offline persistence, AAD authentication, live metrics, sampling beyond
a fixed rate.

## Web analytics instrumentation

Adopted from `@opentelemetry/browser-instrumentation`, not written here. See the
[reference tables](#reference) for what each module emits and how far semantic
conventions actually cover it.

- **Settle the event catalogue.**
  - Follow `exception` and `browser.web_vital` where conventions exist.
  - For page view, where no convention and no upstream module exists, define the
    event name and attributes and document it as a candidate for upstream
    contribution.
  - Confirm the set against the ApplicationInsights-JS occurrence set. Decide
    adopt-versus-build here.
- **Adopt the M0 instrumentation modules.**
  - `experimental/navigation`: decide the Navigation API path
    (`useNavigationApiIfAvailable`), verify SPA soft-navigation coverage against
    Rayfin's routing. It captures route changes by default, the opposite of
    `enableAutoRouteTracking`.
  - `experimental/errors`: confirm stack capture and `applyCustomAttributes` meet
    the Azure Monitor exception envelope needs. It captures unhandled rejections
    by default and recovers cross-origin `"Script error."`. Producing
    `parsedStack` is ours.
  - Pin the module versions and record the breaking-change exposure:
    `@opentelemetry/browser-instrumentation` is `0.8.1` and every module is
    behind an `./experimental/*` subpath.
- **Build the instrumentation registration surface.**
  - Each instrumentation individually enableable and individually importable.
  - Browser tests asserting the emitted event shape for every shipped occurrence
    type.
  - Document what each instrumentation collects and the available opt-outs, as
    input to the privacy review.
- **Follow-up.** Adopt the remaining upstream modules.
  - `experimental/navigation-timing`. Its config interface is empty, so there is
    no way to trim its 24 attributes or tag records.
  - `experimental/resource-timing`, using its `initiatorTypes` and `ignoreUrls`
    filters to control volume.
  - `experimental/web-vitals`, which wraps Google's `web-vitals` package.
  - `experimental/user-action` for click capture. Cost is the privacy-safe
    configuration and deciding the content model versus `clickanalytics-js`.

### What adoption does not cover

- **No page view concept upstream at all** - not in the modules, not in semantic
  conventions. No page view name, no page view duration.
- **Page view performance has the numbers but the wrong shape.**
  `browser.navigation_timing` carries a superset of the Application Insights
  timing fields, but as a standalone flat event with no page identity.
- **The click content model differs.** `user-action` reads `data-otel-*` into
  `browser.element.attributes` - a different prefix from `data-`, with no
  ancestor walk or content-name extraction.
- **No user identity** in either the instrumentation or the SDK package, and no
  cookie manager.
- **No metrics and no page visit time.**

The adopt-versus-build decision is tracked in
[§7 of the implementation plan](IMPLEMENTATION_PLAN.md#7-open-decisions).

## Tracing, propagation, and browser context

`experimental/fetch` and `experimental/xhr` are wired, not written. Both emit
`SpanKind.CLIENT` spans with stable HTTP semantic conventions and perform
CORS-aware `propagation.inject`.

- **Wire HTTP instrumentation and propagation.**
  - `experimental/fetch` and `experimental/xhr` with browser-appropriate
    defaults, a URL filter and the `sanitizeUrl` hook.
  - W3C Trace Context and Baggage propagation, including the allowed-origin list
    for header injection.
- **Implement session and page context.**
  - Session ID generation, storage, timeout and renewal; apply `session.id` to
    both signals. No upstream equivalent exists.
  - Document and page context processor applying URL and page attributes to both
    spans and log records.
- **Test context handling.**
  - Browser tests for propagation round-trip, session continuity and context
    stamping on both signals.
  - Document the async context limitation and the supported explicit-context
    pattern.

## Bundle size

Size is measured by automation in the repository, not written down in a document
that goes stale. The PoC already ships a harness (`poc/size/measure.mjs`,
`npm run size`) that runs a real production build per scenario and regenerates
[`../poc/SIZE_REPORT.md`](../poc/SIZE_REPORT.md); M0 promotes it to a repository
tool that runs in CI.

- **Promote the size harness into a repository tool.**
  - Measure every published entry point tree-shaken through a real bundler,
    reported in gzip.
  - Measure per layer, not just totals: API only, plus SDK, plus the
    distribution, plus the exporter, plus each instrumentation.
  - Per-package deltas must not be summed - shared dependencies are counted once,
    so report measured totals alongside deltas.
  - Regenerate the size report as a build artifact on every run.
- **Report and gate size in CI.**
  - Size report comparing against the base branch, report-only initially.
  - Publish the numbers from each `main` build so regressions show as a trend.
  - Include reference points measured the same way: `ApplicationInsights-JS` and
    upstream `@opentelemetry/browser-sdk`.
  - Set initial absolute budgets per entry point and decide whether the gate
    blocks or reports for the beta.
  - Lint rule banning barrel imports from `@opentelemetry/semantic-conventions`;
    individual constants are effectively free, the barrel is not.
- **Follow-up.** Tree-shaking verification and tuning.
  - Verify `sideEffects: false` empirically: a bare side-effect import must
    bundle to zero bytes.
  - Assert importing one instrumentation does not pull in the others.
  - Size tuning pass once the full feature set is in.

## Build, release, and npm publication

- **Define the release strategy.**
  - Prerelease versioning, `beta` dist-tag, changelog generation, stability
    contract.
  - Reserve the npm scope and package names; confirm ownership and publish rights
    for the publishing identity.
- **Build the release pipeline.**
  - Build, test, pack, sign off, publish, with an approval gate and no local
    publishing.
  - `verify-pack` validation: install the real tarball and load every `exports`
    entry, plus `publint` and are-the-types-wrong checks.
  - SBOM for each published package, attached to the release.
- **Follow-up.** Package provenance and signing on publish, and a release runbook
  covering rollback, deprecation and hotfix.

## Legal, compliance, and release approvals

Queue-driven work owned by other teams, filed at the start rather than when the
code is ready.

- **File open-source release approval.**
  - New public repository and package.
  - Confirm the license, add `LICENSE`, and add the contribution and
    code-of-conduct files required for public release.
  - Third-party dependency license review and attribution: produce `NOTICE` and
    confirm every transitive dependency is on an approved license.
- **File security and privacy review.**
  - Threat model covering browser data collection, connection-string handling,
    transport, and the supply chain of the published package.
  - Privacy review and data-collection documentation.
- **File naming, export and governance approvals.**
  - Package name and branding approval, including trademark review of the name
    and npm scope.
  - Export control classification for the published package.
  - Public repository governance: security policy, issue templates, support
    statement, maintainer list.

## Validation, documentation, and publication

- **Write the beta documentation.**
  - Getting-started guide, configuration reference and event catalogue.
  - Known beta limitations: single instance, no pre-ES2015 browser support,
    `development`-stability semantic conventions, no offline persistence, no AAD,
    async context constraints, deferred instrumentations.
- **Validate the beta build.**
  - End-to-end in a real browser against a real Application Insights resource,
    covering every shipped occurrence type and manual telemetry.
  - Browser compatibility across the confirmed matrix.
- **Publish the beta.**
  - Publish to npm at the `beta` dist-tag.
  - Capture feedback and file follow-up work against M1 onward.
- **Follow-up.** Sample application and a performance sanity check.
  - Sample demonstrating installation, configuration, manual telemetry and
    shutdown.
  - Initialization cost, steady-state overhead, export volume under a realistic
    page.

## Rayfin end-to-end validation

In Rayfin's own application, against their own Application Insights resource, on
their browser matrix. The mock ingestion endpoint and our own browser tests do
not substitute for it.

- **Agree the validation plan and environment.**
  - Which application and environment, which routes and user journeys, which
    Application Insights resource, which browsers, who runs it and who signs off.
  - Provision the Application Insights resource, connection string handling, and
    confirm ingestion is reachable from their origin, CORS and CSP included.
- **Run the integration.**
  - Get a pre-publish build into Rayfin's hands - private dist-tag or tarball -
    so the integration is exercised before the public publish.
  - Install the package, call `initialize()` in their bootstrap, configure the
    connection string, wire shutdown and flush into their page lifecycle.
  - Capture friction points as documentation or API defects.
- **Verify and sign off.**
  - Query their Application Insights resource for: page views on hard load and
    SPA route change, exceptions with a usable `parsedStack`, fetch/XHR
    dependencies, manual events and traces, `session.id` continuity across a
    journey, and correlation between a browser dependency and its server-side
    request.
  - Validate across their browser matrix and measure the bundle-size impact on
    their real production build.
  - Run an acceptance checklist against the agreed plan, record the result, file
    every defect and gap found.
- **Follow-up.** Telemetry volume and cost review once the integration is running
  against real traffic.

---

## Reference

Verified facts the work items above depend on.

### What the upstream modules emit

`@opentelemetry/browser-instrumentation` 0.8.1. Every module is behind an
`./experimental/<name>` subpath and imported individually. Seven of the nine emit
log records via the Logs API with `eventName` set.

| Occurrence | Module | Emits |
|---|---|---|
| Page load + SPA soft navigation | `experimental/navigation` | log records, `browser.navigation` |
| Unhandled errors + promise rejections, with stack | `experimental/errors` | log records, `exception` semconv |
| Navigation and document load timing | `experimental/navigation-timing` | log records, `browser.navigation_timing`, 24 attributes |
| Resource timing | `experimental/resource-timing` | log records, `browser.resource_timing` |
| Web vitals | `experimental/web-vitals` | log records, `browser.web_vital` |
| Click / user action | `experimental/user-action` | log records, `browser.user_action.click`, `data-otel-*` model |
| Console | `experimental/console` | log records, `browser.console` |
| fetch / XHR | `experimental/fetch`, `experimental/xhr` | `SpanKind.CLIENT` spans |

The `opentelemetry-js-contrib` browser instrumentations are not used. The browser
SIG has stated that browser packages spread across `opentelemetry-js` and
`opentelemetry-js-contrib` "will be migrated here or deprecated", and that the
span-based `user-interaction` instrumentation "will be deprecated in favor of
event-based user action telemetry".

### Semantic convention maturity

Verified against `open-telemetry/semantic-conventions`. Only `exception` is
stable; everything else we emit targets a `development` convention that can
change, and page view has no convention at all.

| Occurrence | Convention | Stability |
|---|---|---|
| Exceptions | `exception` | **stable** |
| Web vitals | `browser.web_vital` + `browser.web_vital.*` | development |
| Clicks | `app.screen.click`, `app.widget.click` | development |
| Session start/end | `session.start`, `session.end` | development |
| Crash, jank | `app.crash`, `app.jank` | development |
| Browser context | `browser.brands`, `browser.platform`, `browser.mobile`, `browser.language`, `browser.document.url.full` | development |
| **Page view** | **none** | **-** |

`browser.navigation`, `browser.navigation_timing`, `browser.resource_timing`,
`browser.user_action.click` and `browser.console` are defined by the
instrumentation package, not by the spec.
