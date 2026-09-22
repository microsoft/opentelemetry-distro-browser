// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Instrumentation } from "@opentelemetry/instrumentation";
import { PageViewInstrumentation } from "./pageView/index.js";
import type { InstrumentationOptions } from "../types.js";

/**
 * Creates the distribution-owned instrumentations that are turned on.
 *
 * @remarks
 * Must be called *after* the SDK has registered its logger provider. `InstrumentationBase`
 * resolves its logger in its constructor, so an instrumentation built earlier would hold a no-op
 * logger for its lifetime and silently drop every record.
 *
 * Returns nothing outside a browser. The same entry point is routinely imported by a
 * server-rendered build, and every instrumentation here observes the DOM, so constructing one
 * there would throw during initialization and take the host application down with it.
 *
 * @param options - Per-instrumentation configuration. Omitted entries keep their defaults.
 * @returns The enabled instrumentations, so the caller can disable them on shutdown.
 *
 * @internal
 */
export function createInstrumentations(options: InstrumentationOptions = {}): Instrumentation[] {
  const instrumentations: Instrumentation[] = [];

  if (typeof document === "undefined" || typeof location === "undefined") {
    return instrumentations;
  }

  const pageView = options.pageView ?? {};
  if (pageView.enabled !== false) {
    instrumentations.push(new PageViewInstrumentation(pageView));
  }

  return instrumentations;
}
