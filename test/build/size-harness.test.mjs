// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import assert from "node:assert/strict";
import test from "node:test";
import {
  addDeltas,
  createMarkdownReport,
  executablePublishedEntryPoints,
  scenarios,
} from "../../scripts/measure-bundle-size.mjs";

const instrumentationIds = [
  "console",
  "errors",
  "fetch",
  "navigation",
  "navigation-timing",
  "resource-timing",
  "user-action",
  "web-vitals",
  "xhr",
];

test("covers every published JavaScript entry point and browser instrumentation", () => {
  assert.deepEqual(executablePublishedEntryPoints.sort(), [".", "./instrumentations"]);
  assert.deepEqual(
    scenarios
      .filter(({ group }) => group === "entry-point")
      .map(({ entryPoint }) => entryPoint)
      .sort(),
    executablePublishedEntryPoints.sort(),
  );
  assert.deepEqual(
    scenarios
      .filter(({ group }) => group === "instrumentation")
      .map(({ id }) => id.replace("instrumentation-", ""))
      .sort(),
    instrumentationIds,
  );
});

test("uses measured baselines and a directly measured combined scenario", () => {
  const ids = new Set(scenarios.map(({ id }) => id));
  for (const scenario of scenarios) {
    if (scenario.baseline) assert.ok(ids.has(scenario.baseline));
  }
  assert.equal(scenarios.find(({ id }) => id === "sdk")?.baseline, "api");
  assert.equal(scenarios.find(({ id }) => id === "distribution")?.baseline, "sdk");
  assert.equal(scenarios.find(({ id }) => id === "azure-monitor-exporters")?.baseline, "api");
  assert.equal(scenarios.find(({ id }) => id === "everything")?.baseline, undefined);
});

test("reports measured totals alongside baseline-relative deltas", () => {
  const measured = addDeltas([
    {
      id: "api",
      label: "API",
      group: "layer",
      entryPoint: "api",
      rawBytes: 200,
      gzipBytes: 100,
      chunks: [{ fileName: "entry.js", type: "entry", rawBytes: 200, gzipBytes: 100 }],
    },
    {
      id: "sdk",
      label: "SDK",
      group: "layer",
      entryPoint: "sdk",
      baseline: "api",
      rawBytes: 500,
      gzipBytes: 250,
      chunks: [{ fileName: "entry.js", type: "entry", rawBytes: 500, gzipBytes: 250 }],
    },
    {
      id: "everything",
      label: "Everything",
      group: "total",
      entryPoint: ".",
      rawBytes: 900,
      gzipBytes: 400,
      chunks: [{ fileName: "entry.js", type: "entry", rawBytes: 900, gzipBytes: 400 }],
    },
  ]);
  assert.equal(measured[1].baselineGzipBytes, 100);
  assert.equal(measured[1].gzipDeltaBytes, 150);
  assert.equal(measured[2].gzipDeltaBytes, undefined);

  const markdown = createMarkdownReport({
    package: { name: "test-package", version: "1.0.0" },
    scenarios: measured,
  });
  assert.match(markdown, /Do not sum deltas/);
  assert.match(markdown, /SDK \| api \| 0\.24 kB \| \+0\.15 kB/);
  assert.match(markdown, /Everything \| 0\.39 kB/);
});
