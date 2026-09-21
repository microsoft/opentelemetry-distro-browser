# Repository guidance

## README changes

Do not modify the root `README.md` during general updates unless the user explicitly requests
README changes. This includes feature work, bug fixes, dependency updates, tooling changes, and
formatting. Do not replace the existing README with generated summaries or generic project scaffolding.

When README changes are explicitly requested, preserve its existing structure, voice, and content
unless the requested change requires otherwise, and keep edits limited to the requested scope.

## Browser bundle size

Treat minified browser bundle size as a design constraint for every change, not a final cleanup.
Optimize the emitted production JavaScript rather than source length:

- Use type-only imports and exports for contracts so upstream SDK types add no runtime code.
- Prefer tree-shakeable modules and supported, focused public dependency entry points. Keep optional
  exporters and instrumentations out of unrelated bundles; avoid unnecessary runtime wrappers,
  duplicate helpers, polyfills, and type-only concepts emitted as runtime objects.
- Keep diagnostics concise and actionable. Do not sacrifice correctness, public API compatibility,
  useful error reporting, or readable source through hand-minification or unsafe property mangling.
- For runtime, dependency, or build changes, compare before/after sizes using the same production
  build: `npm run build` followed by `npm run size`. Check minified, gzip, and Brotli output, not
  unminified source size or summed dependency sizes. Investigate unexpected growth with
  `reports/bundle-stats.html` and verify unused exports remain tree-shakeable.

## Page-view instrumentation

`src/instrumentation/pageView/` emits one `browser.page_view` log record per navigation, the
initial document load plus every SPA route change, via the Logs API with a top-level `eventName`.
Upstream `@opentelemetry/browser-instrumentation` has no page-view concept, and its
`browser.navigation` event has no page name, duration, referrer, or correlation id.

Page name resolves as explicit (`setPageName`) then route pattern (`routeResolver`) then
`document.title` then `location.pathname`. `browser.page_view.name_source` is always emitted
alongside the name and is not optional: without it a query cannot tell a stable route pattern from a
mutable document title. Aggregate names only where the source is `explicit` or `route`.

Duration is two different measurements. A document load uses `loadEventEnd - startTime` from
`PerformanceNavigationTiming`, read on the macrotask after `load` because `loadEventEnd` is zero
until the event finishes dispatching. The browser reports no duration for an in-document route
change, so the SPA value is a heuristic: start at the history mutation, wait two animation frames,
then wait for the first idle callback. It does not capture asynchronously loaded content, lazy route
chunks, work in a background tab where `requestAnimationFrame` does not fire, or anything before the
router mutated history. Every record carries `browser.page_view.duration_source`; never average
across sources, and exclude `soft_navigation_capped`, `soft_navigation_interrupted`, and `page_hide`
from duration percentiles. Exactly one record is emitted per navigation in all cases.

The instrumentation mints and publishes a per-navigation correlation id but does not stamp anything;
stamping belongs to a separate processor. Consumers read it through `instrumentation.pageViews`,
typed as the read-only `PageViewSource`, so they cannot mint or mutate a page view. The id is
published when the navigation is observed, not when the record is emitted: a document load publishes
its id before `load` fires, so exceptions, web vitals, and fetch spans produced during the load
correlate to the page view they belong to. Do not move publication to emit time.
`createPageViewContext()` is a factory, not a module-level singleton.

`PageViewInstrumentation` is deliberately not re-exported from `src/index.ts`. `InstrumentationBase`
pulls in `@opentelemetry/api`, whose global registration is a module-level side effect that cannot
be tree-shaken, so exporting the class moves the bundle from ~209 B to ~20.7 kB for every consumer
and fails the `test:build` tree-shaking assertion. Its types are exported instead, so the
configuration surface stays fully typed at zero runtime cost.

Open decisions: upstream `NavigationInstrumentation` also fires per navigation, so running both
emits two records, and the recommendation is for the preset to disable upstream's when page view is
enabled; `NavigationTimingInstrumentation` is complementary and should stay. `browser.page_view.*`
is a deliberate bet on the name from the upstream proposal that closed unmerged. `schemaUrl` is not
set, because `InstrumentationBase` calls `getLogger(name, version)` only.

Runtime wiring is not implemented: `useMicrosoftOpenTelemetry` still throws and the instrumentation
is not constructed anywhere. See the `TODO` in `src/useMicrosoftOpenTelemetry.ts`. Behaviour is
covered by `test/internal/unit/pageViewInstrumentation.test.ts`, which runs in real headless
Chromium.
