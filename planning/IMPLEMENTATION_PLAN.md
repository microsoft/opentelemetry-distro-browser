# OpenTelemetry Browser Distribution Implementation Plan

**Status:** Proposed
**Approach:** Greenfield browser distribution built on upstream OpenTelemetry APIs
**Near-term commitment:** Milestone M0 - Fabric (Rayfin) beta, pre-Ignite
**Prior evidence:** Multi-instance browser PoC in [`../poc/`](../poc/)
**Upstream alignment verified:** 2026-09-10 against
[`open-telemetry/opentelemetry-browser`](https://github.com/open-telemetry/opentelemetry-browser)
`main` @ `c0df3d6`

This document holds the *why*. Everything else has its own document.

| Document | What it covers |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Global bridge, instance model, routing provider, instrumentation bridge, context, export, package layout, public API |
| [`MILESTONES.md`](MILESTONES.md) | M1 onward: multi-instance routing, isolation, lifecycle, and the GA criteria |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | The requirement set: lifecycle, correctness, configuration, performance, packaging, security, diagnostics, testing |
| [`M0_WORK_BREAKDOWN.md`](M0_WORK_BREAKDOWN.md) | The committed milestone, as a list of work items |
| [`../poc/SIZE_REPORT.md`](../poc/SIZE_REPORT.md) | Generated bundle size measurements |

## 1. Goal

A vendor-neutral OpenTelemetry distribution for browser applications, built on
upstream `@opentelemetry/api` and SDK contracts, solving the browser-specific
problems: composition, multi-instance isolation, instrumentation ownership,
lifecycle, performance and packaging.

It is **not** a replacement for or migration of `ApplicationInsights-JS`, which
keeps serving its own customers. Azure Monitor, OTLP and other destinations are
exporters on the standard pipeline, with Azure Monitor first-class.

Applications keep using normal OpenTelemetry APIs. Upstream instrumentations,
processors, exporters, samplers and propagators connect directly where the
contracts permit, and through narrow adapters only where a browser or
multi-instance boundary requires one.

## 2. Product Principles

| Principle | Decision |
|---|---|
| Upstream API first | `@opentelemetry/api` is the canonical API. No parallel tracing API, no duplicated OTel interfaces. |
| Signal choice follows upstream | Browser occurrences are **log records carrying a top-level `eventName`**. Spans are reserved for operations with real duration and backend correlation, primarily fetch/XHR. |
| Logs are a phase-1 signal | The Logs API and a routed `LoggerProvider` are core architecture, not a deferred signal. |
| No client-side aggregation | Emit high-fidelity events; let the backend derive metrics. No browser Metrics SDK ahead of an upstream decision. |
| Vendor neutral | Core packages carry no backend schema, connection strings or destination assumptions. |
| Multi-instance, one global router | One global routing provider routes acquisition to isolated instance providers; a tracer or logger stays bound to the instance chosen at `getTracer()` / `getLogger()` time. |
| Standard extensions, narrow bridges | Adapters only for lifecycle, routing, shared browser patches, or incompatible third-party contracts. |
| Explicit ownership, no silent fallback | Every patch, listener, processor and provider has an owner and a cleanup path. Routing, duplicate-global and lifecycle failures are diagnosed clearly. |
| Greenfield | Build on upstream packages and on the lessons of `ApplicationInsights-JS`, not on an SDK architecture designed for different constraints. |

## 3. PoC Findings

The multi-instance PoC is the evidence base. Full assertion list in
[`poc/README.md`](../poc/README.md).

**Settled.** One provider per signal can be registered with the real
`@opentelemetry/api` and `@opentelemetry/api-logs` and route to multiple logical
SDK instances. Instance selection happens during `getTracer()` / `getLogger()`
via an upstream `Context` value, and the returned tracer or logger keeps that
instance permanently - including when two consumers share a scope and when
upstream instrumentations are initialized inside an instance boundary.
Parent-child survives `await` with an explicit `Context`. Per-instance
`forceFlush()` and idempotent `shutdown()` work, with telemetry-after-shutdown
diagnosed rather than dropped. W3C Trace Context and Baggage round-trip across an
instance boundary, and a pre-existing global OTel SDK is detected, not
overwritten.

**Constraint, not solved.** Instrumentations that patch a browser global cannot
run in more than one instance - two instances both enabling fetch report one
request twice - so a shared patch needs a designated owner until
[M4](MILESTONES.md#m4---instrumentation-interoperability). In
`@opentelemetry/browser-instrumentation` the shared-patch modules are
`navigation`, `console`, `fetch` and `xhr`; the rest attach isolated listeners or
observers and route cleanly.

**Still open.** Automatic async context propagation; production export over a
real transport; duplicate `@opentelemetry/api` packages, iframes, workers, module
federation.

## 4. Upstream Browser Alignment

Verified 2026-09-10 against `open-telemetry/opentelemetry-browser` `main` @
`c0df3d6`. Re-verify before each phase; much of this is still moving.

1. **There is no browser-specific OTel API package**, and none is planned.
   `@opentelemetry/api` stays a peer dependency of both browser packages, so
   upstream-API-first is unchanged.
2. **Browser occurrences are events on the Logs API.**
   `@opentelemetry/browser-instrumentation` depends only on
   `@opentelemetry/api-logs`, and every occurrence instrumentation calls
   `logger.emit({ eventName, severityNumber, attributes })`.
3. **Spans are reduced, not removed.** fetch and XHR still produce
   `SpanKind.CLIENT` spans with `traceparent` injection. A logs-only
   distribution would diverge from upstream. Metrics are the signal actually
   displaced, and that choice is still contested upstream.
4. **Correlation is attribute-based**: `session.id` and
   `browser.document.url.full` stamped on every log and span, with timestamp
   proximity replacing click-to-request parenting. Browser events carry no trace
   context in practice.
5. **The foundations are unstable.** The logs packages are `0.x`, five of the
   seven browser event definitions are unmerged, and **page view has no semantic
   convention at all**. Mitigation: keep event names and attribute keys behind an
   internal mapping layer, so a convention change is a table edit rather than an
   instrumentation rewrite.

Several upstream facts invalidate earlier assumptions: the Events API was
removed and `event.name` is a top-level LogRecord field; Zone.js is abandoned, so
async parenting must be explicit; `WebTracerProvider` is deprecated in favor of
`BasicTracerProvider`; span-based user-interaction and document-load
instrumentation are being deprecated; and fetch/XHR instrumentation is moving out
of `opentelemetry-js` into `opentelemetry-browser`, which is the repository to
track.

## 5. Scope

M0 (Section 6) is a single-instance subset of the initial release.

**Initial release.** A global multi-instance routing layer over
`@opentelemetry/api`, with isolated per-instance tracing **and logging**
pipelines and explicit create/init/lookup/flush/shutdown. Manual tracing through
the OTel API and manual events through the Logs API with a top-level `eventName`.
Routed event-based instrumentation covering the upstream occurrence set, plus
span-based fetch/XHR with W3C Trace Context and Baggage propagation. Supported
ways to attach upstream processors and exporters for both signals and to
initialize upstream instrumentations, with safe ownership rules for shared
patches. `session.id` and page context on both signals. OTLP trace and log export
as the vendor-neutral reference path. ESM-first packages and bundles from one
source, with browser integration, compatibility, lifecycle, performance and
bundle tests.

**Later.** Metrics, once upstream settles its browser metrics decision and
aggregation, cardinality and export semantics are designed. Session and page view
as resource entities. Log sampling. Dynamic instrumentation loading and dynamic
configuration. Backend-specific exporter bundles and legacy-API bridges. CDN
loader, snippet queue and unsupported-browser behavior. Workers and iframes
beyond independently initialized realms.

**Non-goals.** Reimplementing the OTel API or SDK. Building an Application
Insights SDK, or making a legacy AI API the primary surface. Coupling core
routing to a backend or wire format. Transparently supporting every browser
instrumentation in the first release, or claiming arbitrary multi-instance
auto-instrumentation is safe before shared patch behavior is proven. Hiding
unavoidable global OTel constraints from users.

## 6. Milestone M0 - the committed beta

Rayfin, in the Fabric team, needs something consumable before Ignite. The date is
external and fixed; scope is the only variable.

Ship a thin, honest distribution first - compose the upstream browser packages,
add an Azure Monitor exporter, add web analytics coverage - then build the
routing, isolation and lifecycle architecture in
[`ARCHITECTURE.md`](ARCHITECTURE.md) on top. **M0 is a subset of this plan
brought forward, not a parallel product**, and the public surface it ships is the
one M2 keeps.

Two constraints shape it. **M0 composes upstream packages; it does not
reimplement them** - our own SDK, the multi-instance provider and the instance
registry already proven in [`../poc/`](../poc/) are the follow-up. And **the
binding constraint is the approval queue, not engineering effort** - legal,
security, privacy and naming approvals are multi-week, owned outside the team,
and gate publication after the code is done, so they are filed on day one.

**The itemized work is in
[`M0_WORK_BREAKDOWN.md`](M0_WORK_BREAKDOWN.md)**, which is the source of truth
for the milestone. This section only places it in the plan.

## 7. Open Decisions

**Blocking M0.** Whether page view and page view performance are built on top of
the adopted upstream modules, and how closely the click content model tracks
`clickanalytics-js`. The
exact upstream package and version range including the `0.x` logs packages. The
browser bundle cost of the new exporter against the budget. Final package names
and organizational scope.

**Multi-instance architecture, Phases 0-4.** Missing-instance behavior during
`getTracer()` / `getLogger()`, and stale bound-tracer behavior after shutdown.
Whether one optional default instance is allowed. Browser context manager and the
supported async matrix. Ownership model for shared fetch/XHR patches and for
observer-based instrumentation shared across instances. Whether we ship a thin
event-emission facade over the Logs API. Internal semantic conventions mapping
scope and upgrade policy.

**Later phases and GA.** Per-signal batch, flush-on-unload and page-hide export
behavior. Absolute gzipped budgets per entry point, allowed per-change growth,
and whether the size gate blocks or reports. Scope of dynamic configuration and
the transform/filter contract. Metrics inclusion. Session and page view as
resource entities versus processor-injected attributes. Whether server-provided
`traceparent` page-trace correlation is supported. CDN loader and legacy-browser
policy, and whether a prebuilt CDN/IIFE bundle is published at all given upstream
publishes none. Whether property mangling is revisited, and on what threshold.
Runtime statistics fields and stability guarantees.
