// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { expect, it } from "vitest";
import standardBundle from "../../dist/esm/index.js?raw";
import minifiedBundle from "../../dist/esm/index.min.js?raw";
import { version } from "../../package.json";

it.each([
  { name: "standard", source: standardBundle },
  { name: "minified", source: minifiedBundle },
])("imports the $name bundle as native browser ESM", async ({ source }) => {
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));

  try {
    // Import the emitted bytes directly, without Vite transforming the module.
    const distro: typeof import("../../src/index.js") = await import(/* @vite-ignore */ url);
    expect(Object.keys(distro).sort()).toEqual([
      "OPENTELEMETRY_BROWSER_VERSION",
      "useMicrosoftOpenTelemetry",
    ]);
    expect(distro.OPENTELEMETRY_BROWSER_VERSION).toBe(version);
    expect(() => distro.useMicrosoftOpenTelemetry({})).toThrow("not implemented");
    expect(window).not.toHaveProperty("OpenTelemetryBrowser");
  } finally {
    URL.revokeObjectURL(url);
  }
});
