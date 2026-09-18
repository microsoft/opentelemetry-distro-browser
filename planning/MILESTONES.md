# Milestones M1 and beyond

**Status:** Proposed. Part of the [implementation plan](IMPLEMENTATION_PLAN.md).

What follows M0. [`M0_WORK_BREAKDOWN.md`](M0_WORK_BREAKDOWN.md) is the committed
beta: a single-instance distribution that composes upstream packages. These
milestones build the multi-instance routing, isolation and lifecycle
architecture described in [`ARCHITECTURE.md`](ARCHITECTURE.md) underneath it, and
end at general availability.

M0 does not cancel this work — it is what makes the distribution safe to adopt
beyond one consumer. The public surface M0 ships is the one M2 keeps.

These are not itemized to the level of M0. Each milestone gets its own breakdown
when it is picked up.

---

## M1 - Graduate the PoC

The [PoC](../poc/) proved the multi-instance model against a custom in-memory
span implementation. M1 makes it real.

- Port the PoC into the package layout without changing its proven scenario, and
  turn its conclusions and gaps into executable acceptance tests.
- Replace the custom in-memory span implementation with two real upstream SDK
  tracer providers and in-memory exporters.
- Keep the overlapping Alpha/Beta browser test with identical instrumentation
  scope names and explicit async parent contexts.
- Record architecture decisions for: one global routing provider per signal;
  tracer and logger binding at acquisition; missing-instance behavior; global
  ownership conflicts; browser context limitations.
- Extend the M0 repository foundation with the API report gate, the compatibility
  policy for upstream OTel versions, and blocking per-entry-point bundle budgets
  on top of the M0 size automation.

**Done when** the original PoC passes using real isolated upstream SDK pipelines
and its architecture decisions are written down.

## M2 - Routing and instance lifecycle

- Bridge state machine and instance registry.
- Routing provider delegation with instance-bound tracer caching, and the same
  for `RoutingLoggerProvider` and loggers.
- Transactional instance startup with reverse-order rollback.
- Per-instance `forceFlush()` and idempotent `shutdown()` across both pipelines,
  plus coordinated distribution shutdown.
- Stale tracer and logger behavior, and no telemetry accepted after shutdown.
- Global conflict diagnostics that never overwrite another SDK, for both global
  registrations.
- Stress create/start/use/flush/shutdown loops for leaked state.

**Done when** two real instances run simultaneously, export only their own spans
and log records, and shut down independently with no leaked hooks, timers or
pipeline state.

## M3 - Context and propagation

- Integrate the selected upstream browser context manager and support
  deterministic explicit context across async boundaries.
- W3C Trace Context and Baggage injection and extraction, with configurable
  cross-origin allow lists.
- Test nested instance boundaries, active span contexts, callbacks, promises,
  timers, DOM events, and the unsupported async cases.
- Publish an exact context support matrix.

**Done when** supported context paths preserve instance, trace and parent
identity, and unsupported paths are documented and do not cross pipelines.

## M4 - Instrumentation interoperability

- Instrumentation initialization and binding helper for both the routed tracer
  provider and the routed logger provider.
- Run the upstream event-based browser instrumentations through it and verify
  each emits routed log records with the expected `eventName`.
- Stand up the internal semantic conventions mapping layer and assert event names
  and attribute keys through it rather than at call sites.
- Apply `session.id` and document/page context to both signals through paired
  processors.
- Resolve shared-patch ownership for fetch, XHR, navigation and console, and
  document safe ownership semantics per instrumentation category — including
  observer-based instrumentations that do not patch globals.
- Detect duplicate patch attempts, duplicate observer registrations and
  incompatible ownership at startup; disable in reverse order on rollback and
  shutdown.

**Done when** the supported instrumentation matrix produces correctly routed
spans and log records in overlapping instances and unloads cleanly, with no
duplicated or cross-routed events from shared browser globals.

## M5 - Exporter and processor interoperability

- Validate simple and batch processors per instance for both signals, including
  the shorter default log batch delay.
- Validate OTLP/HTTP export of traces and logs through a Collector.
- Test custom processors, exporters, samplers, resources and ID generators.
- Define processor and exporter error and timeout propagation.
- Test bounded queues, page hide, unload, offline transitions and failed exports,
  and confirm events emitted immediately before navigation away are not lost.
- Document the extension contracts and version requirements.

**Done when** standard upstream and custom pipeline components attach without
distribution-specific wrappers, unless a documented browser bridge is required.

## M6 - Coexistence and realm boundaries

- Another provider registered before the distribution.
- Duplicate `@opentelemetry/api` package copies.
- Module federation and independently bundled consumers.
- Iframes and workers as separate realms.
- Multiple copies and versions of this distribution.

**Done when** every tested topology either works predictably or fails with an
actionable diagnostic. None may silently mix pipelines.

## M7 - Dynamic management and optional bridges

- Instrumentation load and unload, once ownership semantics are stable.
- Dynamic configuration, only for options with atomic update and rollback.
- A narrow bridge interface for integrations that cannot consume standard OTel
  contracts directly.
- Optional backend exporters in separate packages; legacy API bridges evaluated
  independently and kept out of core.

**Done when** optional capabilities preserve vendor neutrality, instance
isolation, lifecycle guarantees and tree shaking.

## M8 - Metrics, loader, and general availability

- Metrics architecture and browser feasibility review, gated on the upstream
  browser metrics decision. Default position is to derive metrics downstream from
  events rather than emit them.
- Reassess session and page view as resource entities once upstream resolves the
  entity model, and plan migration off processor-injected attributes.
- Decide and document the browser target, CDN loader/snippet, ES2015 loader,
  pre-ES2015 behavior, and the callback/promise initialization contract. If a
  loader or no-op is approved, they are separate size-budgeted packages —
  fallback logic never goes in the full SDK.
- Finalize npm exports, source maps, API documentation, examples and support
  policy.
- Preview adoption across multiple frameworks, bundlers, instrumentations,
  collectors and exporters.
- Threat model, privacy review, performance sign-off and API review.

### General availability criteria

- Applications use the standard upstream OTel API for manual telemetry, and the
  standard Logs API with a top-level `eventName` for events. No proprietary
  event API.
- Upstream event-based browser instrumentations run unmodified against the routed
  logger provider, and supported instrumentations connect through documented
  configuration without double patching or crossing pipelines.
- At least two overlapping instances stay isolated with identical scope names.
- W3C context and baggage work across the documented browser and network paths.
- Standard processors and exporters attach without proprietary replacements.
- Startup rollback, per-instance shutdown and distribution shutdown pass leak and
  race stress tests; cleanup enforcement reports no orphaned resources across
  repeated real-browser runs.
- Conflicting globals and unsupported topologies produce actionable diagnostics.
- API, browser, compatibility, OTLP integration, performance, bundle, privacy and
  security gates pass, and absolute and regression bundle budgets are approved
  and passing for every published entry point.
- Browser, context, instrumentation, topology and extension compatibility
  matrices are published.
- Core packages contain no Application Insights-specific API or schema.
