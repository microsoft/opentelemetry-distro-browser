// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import { BrowserDetector, browserDetector } from "../../../../src/resource/index.js";

interface FakeNavigator {
  language?: unknown;
  userAgent?: unknown;
  userAgentData?: unknown;
}

function detectWith(nav: FakeNavigator | undefined): Record<string, unknown> {
  vi.stubGlobal("navigator", nav);
  try {
    return browserDetector.detect().attributes as Record<string, unknown>;
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("BrowserDetector", () => {
  it("exports a shared instance of the class", () => {
    expect(browserDetector).toBeInstanceOf(BrowserDetector);
  });

  it("detects attributes from the real browser it runs in", () => {
    const attributes = browserDetector.detect().attributes ?? {};

    expect(typeof attributes["browser.language"]).toBe("string");
    expect(typeof attributes["user_agent.original"]).toBe("string");
    // Tests run in Chromium, which implements User-Agent Client Hints.
    expect(Array.isArray(attributes["browser.brands"])).toBe(true);
    expect(typeof attributes["browser.platform"]).toBe("string");
    expect(typeof attributes["browser.mobile"]).toBe("boolean");
  });

  it("emits every attribute when User-Agent Client Hints are available", () => {
    const attributes = detectWith({
      language: "en-US",
      userAgent: "Mozilla/5.0 Test",
      userAgentData: {
        brands: [
          { brand: "Chromium", version: "120" },
          { brand: "Not_A Brand", version: "24" },
        ],
        mobile: false,
        platform: "Windows",
      },
    });

    expect(attributes).toEqual({
      "browser.language": "en-US",
      "user_agent.original": "Mozilla/5.0 Test",
      "browser.brands": ["Chromium 120", "Not_A Brand 24"],
      "browser.platform": "Windows",
      "browser.mobile": false,
    });
  });

  it("omits client-hint attributes when userAgentData is unavailable", () => {
    const attributes = detectWith({ language: "fr-FR", userAgent: "Mozilla/5.0 Firefox" });

    expect(attributes).toEqual({
      "browser.language": "fr-FR",
      "user_agent.original": "Mozilla/5.0 Firefox",
    });
  });

  it("never falls back to the legacy navigator.platform", () => {
    const attributes = detectWith({
      language: "en-US",
      userAgent: "Mozilla/5.0 Safari",
      platform: "MacIntel",
    } as FakeNavigator);

    expect(attributes).not.toHaveProperty("browser.platform");
  });

  it("returns no attributes when navigator is undefined", () => {
    expect(detectWith(undefined)).toEqual({});
  });

  it("omits attributes rather than emitting empty or placeholder values", () => {
    const attributes = detectWith({
      language: "",
      userAgent: "",
      userAgentData: { brands: [], platform: "", mobile: undefined },
    });

    expect(attributes).toEqual({});
  });

  it("skips malformed brand entries and keeps well-formed ones", () => {
    const attributes = detectWith({
      language: "en-US",
      userAgent: "ua",
      userAgentData: {
        brands: [null, { version: "1" }, { brand: "" }, { brand: "Chromium", version: "120" }],
      },
    });

    expect(attributes["browser.brands"]).toEqual(["Chromium 120"]);
  });

  it("keeps a brand with no version instead of dropping it", () => {
    const attributes = detectWith({
      language: "en-US",
      userAgent: "ua",
      userAgentData: { brands: [{ brand: "Chromium" }] },
    });

    expect(attributes["browser.brands"]).toEqual(["Chromium"]);
  });

  it("does not emit the mutable document URL on the resource", () => {
    const attributes = browserDetector.detect().attributes ?? {};

    expect(attributes).not.toHaveProperty("browser.document.url.full");
  });

  it("does not throw when navigator members have unexpected types", () => {
    expect(() =>
      detectWith({ language: 42, userAgent: {}, userAgentData: { brands: "nope" } }),
    ).not.toThrow();
  });
});
