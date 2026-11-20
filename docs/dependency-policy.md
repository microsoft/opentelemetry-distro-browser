# OpenTelemetry Dependency Policy

## Pinned versions

OpenTelemetry runtime dependencies use exact versions in the root `package.json`. Exact pins are
required because experimental instrumentation and exporter packages may introduce breaking changes
in a minor release. `@opentelemetry/api` is the exception: its peer range is
`>=1.10.0 <1.11.0`, with `1.10.0` pinned for development.

| Release cohort          | Packages                                                                                                              | Version   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | --------- |
| API                     | `@opentelemetry/api`                                                                                                  | `1.10.0`  |
| Stable SDK              | `@opentelemetry/core`, `@opentelemetry/resources`, `@opentelemetry/sdk-trace`, `@opentelemetry/sdk-logs`              | `3.1.1`   |
| Experimental SDK        | `@opentelemetry/exporter-logs-otlp-http`, `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/instrumentation` | `0.301.2` |
| Browser API             | `@opentelemetry/browser-api`                                                                                          | `0.2.1`   |
| Browser SDK             | `@opentelemetry/browser-sdk`                                                                                          | `0.9.1`   |
| Browser instrumentation | `@opentelemetry/browser-instrumentation`                                                                              | `0.12.1`  |
| Semantic conventions    | `@opentelemetry/semantic-conventions`                                                                                 | `1.45.0`  |

The different version numbers are intentional. OpenTelemetry JavaScript publishes stable SDK,
development SDK, and instrumentation packages on related but independently numbered release
lines. Compatibility is determined from package peer dependencies and verified by tests, not by
forcing every package to use the same version number.

The Logs API is part of `@opentelemetry/api` starting at 1.10.0, and the Logs SDK is stable at
3.x. Do not combine API 1.10.x with the removed SDK 2.x trace packages. Browser packages remain
experimental and independently versioned. Native instrumentations receive their providers on the
first `enable()` call; the distribution bridges that lifecycle to its existing registration API.
An initialized native object cannot be rebound to a different handle. Construct a fresh instance
for a later registration, and set native configuration before the first enable.

## Upgrade policy

1. Upgrade an OpenTelemetry release cohort atomically. Do not update only one package from the
   stable SDK or `0.x` development SDK cohort.
2. Inspect release notes, public type declarations, peer dependencies, and browser support before
   changing a pin. Do not import internal OpenTelemetry paths or carry local forks without an
   approved architecture decision.
3. Keep direct OpenTelemetry dependencies exact. Regenerate and commit `package-lock.json` with
   the manifest so clean installs resolve the reviewed dependency graph.
4. Run `npm ci`, `npm ls`, `npm run typecheck`, `npm run lint`, and the unit and browser test suites.
   Upgrades must preserve multi-instance isolation, context propagation, lifecycle cleanup, and
   tree shaking.
5. Review duplicate versions of `@opentelemetry/api`. A release must use one compatible API copy
   in the production dependency graph.
6. Treat every `0.x` minor update as potentially breaking. Record any compatibility limitation or
   fallback before merging an update to browser instrumentation or another experimental package.
7. Update the table above in the same change as the package pins. OpenTelemetry dependency updates
   require API and package-owner review.

Automated dependency update tooling may open pull requests, but it must not merge OpenTelemetry
updates automatically.
