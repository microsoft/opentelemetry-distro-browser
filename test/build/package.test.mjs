import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rollup } from "rollup";
import ts from "typescript";

const root = new URL("../../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const require = createRequire(import.meta.url);
const esmBundle = "dist/esm/index";

test("the package exposes only ESM entry points without legacy entry fields", () => {
  assert.equal(pkg.type, "module");
  assert.equal(pkg.sideEffects, false);
  assert.equal(Object.hasOwn(pkg, "main"), false);
  assert.equal(Object.hasOwn(pkg, "module"), false);
  assert.deepEqual(pkg.exports, {
    ".": {
      import: {
        types: "./dist/esm/index.d.ts",
        default: "./dist/esm/index.js",
      },
    },
    "./package.json": "./package.json",
  });
  assert.equal(pkg.types, pkg.exports["."].import.types);
});

test("the build produces only ESM bundles, declarations, and source maps", async () => {
  assert.deepEqual((await readdir(new URL("dist/", root))).sort(), ["esm"]);
  assert.deepEqual((await readdir(new URL("dist/esm/", root))).sort(), [
    "index.d.ts",
    "index.js",
    "index.js.map",
    "index.min.js",
    "index.min.js.map",
  ]);
});

test("the package can be imported as ES modules", async () => {
  const distro = await import(pkg.name);
  assert.equal(distro.OPENTELEMETRY_BROWSER_VERSION, pkg.version);
  assert.throws(() => distro.useMicrosoftOpenTelemetry({}), /not implemented/);
});

test("the package does not expose a CommonJS entry point", () => {
  assert.throws(() => require(pkg.name), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});

test("the package metadata remains exported", () => {
  assert.deepEqual(require(`${pkg.name}/package.json`), pkg);
});

for (const suffix of [".js", ".min.js"]) {
  test(`the ${suffix} bundle exposes the same ESM API`, async () => {
    const distro = await import(new URL(`${esmBundle}${suffix}`, root));
    const entry = await import(pkg.name);
    assert.deepEqual(Object.keys(distro).sort(), Object.keys(entry).sort());
    assert.equal(distro.OPENTELEMETRY_BROWSER_VERSION, pkg.version);
    assert.throws(() => distro.useMicrosoftOpenTelemetry({}), /not implemented/);
  });
}

test("Terser produces a smaller ESM bundle", async () => {
  const [standard, minified] = await Promise.all(
    [".js", ".min.js"].map((suffix) => readFile(new URL(`${esmBundle}${suffix}`, root))),
  );
  assert.ok(minified.byteLength < standard.byteLength);
});

test("the ESM entry point ships TypeScript declarations", async () => {
  const declaration = await readFile(new URL(pkg.exports["."].import.types, root), "utf8");
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
});

for (const [name, module, moduleResolution] of [
  ["NodeNext", ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
  ["Bundler", ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
]) {
  test(`ESM consumers resolve declarations with ${name}`, () => {
    const program = ts.createProgram(
      [fileURLToPath(new URL("fixtures/consumer.mts", import.meta.url))],
      {
        target: ts.ScriptTarget.ES2022,
        module,
        moduleResolution,
        strict: true,
        noEmit: true,
        types: [],
      },
    );
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.equal(
      diagnostics.length,
      0,
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: ts.sys.getCurrentDirectory,
        getNewLine: () => "\n",
      }),
    );
  });
}

test("unused exports and side-effect-only imports remain tree-shakeable", async () => {
  const bundle = await rollup({
    input: fileURLToPath(new URL("fixtures/tree-shaking.mjs", import.meta.url)),
    plugins: [nodeResolve({ browser: true })],
  });
  try {
    const { output } = await bundle.generate({ format: "es" });
    assert.equal(output.length, 1);
    assert.equal(output[0].code.trim(), "const retained = true;\n\nexport { retained };");
  } finally {
    await bundle.close();
  }
});

test("every JavaScript bundle ships a source map", async () => {
  const bundles = [pkg.exports["."].import.default, `${esmBundle}.min.js`];
  for (const bundle of bundles) {
    const code = await readFile(new URL(bundle, root), "utf8");
    assert.ok(code.includes(`//# sourceMappingURL=${bundle.split("/").at(-1)}.map`));
    const sourceMap = JSON.parse(await readFile(new URL(`${bundle}.map`, root), "utf8"));
    assert.equal(sourceMap.version, 3);
    assert.ok(sourceMap.sources.length > 0);
    assert.ok(sourceMap.sourcesContent.some((source) => source.includes(pkg.version)));
  }
});
