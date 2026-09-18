import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const root = new URL("../../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const require = createRequire(import.meta.url);
const browserBundle = "dist/browser/opentelemetry-distro-browser";

test("the package can be imported as ES modules", async () => {
  const distro = await import(pkg.name);
  assert.equal(distro.OPENTELEMETRY_BROWSER_VERSION, pkg.version);
  assert.throws(() => distro.useMicrosoftOpenTelemetry({}), /not implemented/);
});

test("the package can be required as CommonJS", () => {
  const distro = require(pkg.name);
  assert.equal(distro.OPENTELEMETRY_BROWSER_VERSION, pkg.version);
  assert.throws(() => distro.useMicrosoftOpenTelemetry({}), /not implemented/);
});

for (const suffix of [".js", ".min.js"]) {
  test(`the browser ${suffix} bundle runs without Node.js globals`, async () => {
    const code = await readFile(new URL(`${browserBundle}${suffix}`, root), "utf8");
    const context = {};
    runInNewContext(code, context);
    assert.equal(context.OpenTelemetryBrowser.OPENTELEMETRY_BROWSER_VERSION, pkg.version);
    assert.throws(
      () => context.OpenTelemetryBrowser.useMicrosoftOpenTelemetry({}),
      /not implemented/,
    );
  });
}

test("Terser produces a smaller browser bundle", async () => {
  const [standard, minified] = await Promise.all(
    [".js", ".min.js"].map((suffix) => readFile(new URL(`${browserBundle}${suffix}`, root))),
  );
  assert.ok(minified.byteLength < standard.byteLength);
});

test("both module formats ship TypeScript declarations", async () => {
  for (const condition of ["import", "require"]) {
    const path = pkg.exports["."][condition].types;
    const declaration = await readFile(new URL(path, root), "utf8");
    assert.match(declaration, /export\s*\{[^}]*OPENTELEMETRY_BROWSER_VERSION/);
    assert.match(declaration, /export\s*\{[^}]*useMicrosoftOpenTelemetry/);
    for (const type of [
      "AzureMonitorOptions",
      "MicrosoftOpenTelemetryBrowser",
      "MicrosoftOpenTelemetryBrowserOptions",
      "OtlpOptions",
    ]) {
      assert.match(declaration, new RegExp(`export type\\s*\\{[^}]*\\b${type}\\b`));
    }
  }
});

test("every JavaScript bundle ships a source map", async () => {
  const bundles = [
    pkg.exports["."].import.default,
    pkg.exports["."].require.default,
    `${browserBundle}.js`,
    `${browserBundle}.min.js`,
  ];
  for (const bundle of bundles) {
    const sourceMap = JSON.parse(await readFile(new URL(`${bundle}.map`, root), "utf8"));
    assert.equal(sourceMap.version, 3);
    assert.ok(sourceMap.sources.length > 0);
    assert.ok(sourceMap.sourcesContent.some((source) => source.includes(pkg.version)));
  }
});
