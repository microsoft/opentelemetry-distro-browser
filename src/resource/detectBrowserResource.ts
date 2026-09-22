// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defaultResource, type Resource } from "@opentelemetry/resources";

/**
 * Builds the resource the distribution attaches to every span and log record.
 *
 * @remarks
 * The result is the OpenTelemetry default resource with the caller's own resource merged on top,
 * so a caller-supplied attribute always wins.
 *
 * No browser detector runs by default. Many backends derive the browser and operating system from
 * the User-Agent header of the export request, so emitting `browser.*` or `user_agent.*` as
 * resource attributes would repeat, on every exported payload, information the receiver can
 * already determine. Callers who need those attributes in the telemetry itself — because they
 * export somewhere that performs no such enrichment, or because they want the exact client-hint
 * values rather than a parsed approximation — opt in by passing the detectors through `resource`:
 *
 * ```ts
 * detectBrowserResource(detectResources({ detectors: [browserDetector, userAgentDetector] }));
 * ```
 *
 * Keeping the default empty also keeps both detectors out of the bundle for applications that
 * never name them, since nothing on this path references them.
 *
 * This is safe to call during initialization and in non-browser environments: it neither touches
 * browser globals nor throws.
 *
 * This is deliberately not re-exported from the package entry point. Reaching it from the root
 * barrel would make the package's value import of `@opentelemetry/resources` unconditional, which
 * defeats the tree-shaking guarantee asserted by the build tests. `useMicrosoftOpenTelemetry` will
 * import it directly once runtime initialization exists and the SDK packages are loaded anyway.
 *
 * @param resource - Resource to layer on top of the default resource.
 * @returns The merged resource.
 * @internal
 */
export function detectBrowserResource(resource?: Resource): Resource {
  const base = defaultResource();

  return resource ? base.merge(resource) : base;
}
