// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expect, it } from "vitest";
import standardBundle from "../../dist/browser/opentelemetry-distro-browser.js?raw";
import minifiedBundle from "../../dist/browser/opentelemetry-distro-browser.min.js?raw";
import { version } from "../../package.json";

declare global {
  interface Window {
    OpenTelemetryBrowser?: typeof import("../../src/index.js");
  }
}

it.each([
  { name: "standard", source: standardBundle },
  { name: "minified", source: minifiedBundle },
])("loads the $name bundle as a browser script", ({ source }) => {
  const frame = document.createElement("iframe");
  document.body.append(frame);

  try {
    const frameWindow = frame.contentWindow;
    if (!frameWindow) {
      throw new Error("Could not create the browser script test frame.");
    }

    const script = frameWindow.document.createElement("script");
    script.textContent = source;
    frameWindow.document.head.append(script);

    expect(frameWindow.OpenTelemetryBrowser?.OPENTELEMETRY_BROWSER_VERSION).toBe(version);
  } finally {
    frame.remove();
  }
});
