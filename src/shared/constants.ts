// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Version of this browser distribution.
 * @public
 */
export const OPENTELEMETRY_BROWSER_VERSION: string = "0.1.0-beta.1";

/** Shared across separately bundled adapters and the core without claiming a public property. @internal */
export const ROUTE_SOURCE_ACTIVE = /* @__PURE__ */ Symbol.for(
  "@microsoft/opentelemetry-browser route source active",
);
