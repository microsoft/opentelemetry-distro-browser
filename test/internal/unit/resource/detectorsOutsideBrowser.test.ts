// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";

// Neither `window` nor `document` can be redefined in a real browser, so a non-browser scope cannot
// be simulated by stubbing globals. Forcing the scope check instead proves that the detectors
// consult it and emit nothing when it fails, even though `navigator` is present and populated.
vi.mock("../../../../src/resource/isBrowserEnvironment.js", () => ({
  isBrowserEnvironment: () => false,
}));

const { browserDetector } = await import("../../../../src/resource/BrowserDetector.js");
const { userAgentDetector } = await import("../../../../src/resource/UserAgentDetector.js");

describe("detectors outside a browser scope", () => {
  it("navigator really is available, so the guard is what is under test", () => {
    expect(typeof navigator.userAgent).toBe("string");
    expect(navigator.userAgent).not.toBe("");
  });

  it("BrowserDetector emits nothing rather than the server locale", () => {
    expect(browserDetector.detect().attributes).toEqual({});
  });

  it("UserAgentDetector emits nothing rather than the runtime user agent", () => {
    expect(userAgentDetector.detect().attributes).toEqual({});
  });
});
