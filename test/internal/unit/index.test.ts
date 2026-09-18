// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { version } from "../../../package.json";
import { OPENTELEMETRY_BROWSER_VERSION } from "../../../src/index.js";

describe("package entry point", () => {
  it("exports the package version", () => {
    expect(OPENTELEMETRY_BROWSER_VERSION).toBe(version);
  });
});
