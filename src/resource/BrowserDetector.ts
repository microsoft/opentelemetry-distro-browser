// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type {
  DetectedResource,
  DetectedResourceAttributes,
  ResourceDetector,
} from "@opentelemetry/resources";
import {
  ATTR_BROWSER_BRANDS,
  ATTR_BROWSER_LANGUAGE,
  ATTR_BROWSER_MOBILE,
  ATTR_BROWSER_PLATFORM,
} from "@opentelemetry/semantic-conventions/incubating";

/**
 * Shape of a single entry of `NavigatorUAData.brands`, as defined by the User-Agent Client Hints
 * specification. Declared locally because it is not part of the default TypeScript DOM library.
 */
interface NavigatorUABrandVersion {
  brand?: string;
  version?: string;
}

/**
 * Narrow local declaration of `navigator.userAgentData`. Only the low-entropy, synchronously
 * available members are modelled.
 */
interface NavigatorUAData {
  brands?: NavigatorUABrandVersion[];
  mobile?: boolean;
  platform?: string;
}

interface NavigatorWithUAData extends Navigator {
  userAgentData?: NavigatorUAData;
}

/**
 * Formats brand/version pairs as `` `${brand} ${version}` `` (e.g. `"Chromium 120"`). Returns
 * `undefined` when no well-formed entry exists so the caller can omit the attribute instead of
 * emitting an empty array.
 */
function formatBrands(brands: NavigatorUABrandVersion[] | undefined): string[] | undefined {
  if (!Array.isArray(brands)) {
    return undefined;
  }

  const formatted: string[] = [];
  for (const entry of brands) {
    if (!entry || typeof entry.brand !== "string" || entry.brand === "") {
      continue;
    }
    formatted.push(
      typeof entry.version === "string" && entry.version !== ""
        ? `${entry.brand} ${entry.version}`
        : entry.brand,
    );
  }

  return formatted.length > 0 ? formatted : undefined;
}

/**
 * Detects the `browser.*` resource attributes describing the browser the instrumented application
 * runs in, following the OpenTelemetry browser resource semantic conventions.
 *
 * `browser.brands`, `browser.platform` and `browser.mobile` come from the User-Agent Client Hints
 * API, which is Chromium-only; on other engines they are legitimately absent. Values derived from
 * the user agent string are the responsibility of the separate `UserAgentDetector`.
 *
 * Detection is fully synchronous: every source is a synchronous browser global. The detector never
 * throws and is safe to run in non-browser environments (SSR, Node prerendering, web workers,
 * jsdom), where it simply yields fewer attributes — or none at all.
 *
 * Attributes that cannot be determined are omitted rather than emitted with a placeholder value.
 *
 * @public
 */
export class BrowserDetector implements ResourceDetector {
  /**
   * Returns the browser resource attributes that can be determined in the current environment.
   */
  detect(): DetectedResource {
    const attributes: DetectedResourceAttributes = {};

    // `window` is deliberately not referenced: web workers expose `navigator` without a `window`,
    // and `navigator` alone covers every source we need.
    const nav: NavigatorWithUAData | undefined =
      typeof navigator === "undefined" ? undefined : navigator;

    if (!nav) {
      return { attributes };
    }

    if (typeof nav.language === "string" && nav.language !== "") {
      attributes[ATTR_BROWSER_LANGUAGE] = nav.language;
    }

    // User-Agent Client Hints are Chromium-only. On other engines the `browser.brands`,
    // `browser.platform` and `browser.mobile` attributes are legitimately absent.
    const uaData = nav.userAgentData;
    if (!uaData) {
      return { attributes };
    }

    const brands = formatBrands(uaData.brands);
    if (brands) {
      attributes[ATTR_BROWSER_BRANDS] = brands;
    }

    // The convention explicitly forbids falling back to the legacy `navigator.platform`: its values
    // are inconsistent across browsers and do not match the platform vocabulary it defines.
    if (typeof uaData.platform === "string" && uaData.platform !== "") {
      attributes[ATTR_BROWSER_PLATFORM] = uaData.platform;
    }

    if (typeof uaData.mobile === "boolean") {
      attributes[ATTR_BROWSER_MOBILE] = uaData.mobile;
    }

    return { attributes };
  }
}

/**
 * Shared {@link BrowserDetector} instance.
 *
 * @public
 */
export const browserDetector = /* @__PURE__ */ new BrowserDetector();
