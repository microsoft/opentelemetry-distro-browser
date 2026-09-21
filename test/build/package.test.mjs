import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { startBrowserSdk } from "@opentelemetry/browser-sdk";
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rollup } from "rollup";
import ts from "typescript";

const root = new URL("../../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const require = createRequire(import.meta.url);
const esmBundle = "dist/esm/index";

async function bundleConsumer(source) {
  const input = "\0consumer";
  const bundle = await rollup({
    input,
    plugins: [
      {
        name: "package-consumer",
        resolveId(id) {
          if (id === input) return input;
          if (id === "distro") return fileURLToPath(new URL(pkg.exports["."].import.default, root));
        },
        load(id) {
          if (id === input) return source;
        },
      },
      nodeResolve({ browser: true }),
      commonjs(),
    ],
    onwarn(warning, defaultHandler) {
      if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
      if (warning.code !== "EMPTY_BUNDLE") defaultHandler(warning);
    },
  });
  try {
    const { output } = await bundle.generate({ format: "es" });
    assert.equal(output.length, 1);
    assert.equal(output[0].type, "chunk");
    assert.deepEqual(output[0].imports, []);
    return output[0];
  } finally {
    await bundle.close();
  }
}

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

async function exerciseNpmPackage(distro) {
  const spans = new InMemorySpanExporter();
  const records = new InMemoryLogRecordExporter();
  const tracer = trace.getTracer("package-consumer");
  const logger = logs.getLogger("package-consumer");
  const traceConfig = { processors: [new SimpleSpanProcessor(spans)] };
  const logConfig = {
    processors: [new SimpleLogRecordProcessor({ exporter: records })],
  };
  const telemetry = distro.useMicrosoftOpenTelemetry({ traces: traceConfig, logs: logConfig });
  try {
    tracer.startSpan("manual").end();
    logger.emit({ eventName: "manual" });
    await Promise.all(
      [...traceConfig.processors, ...logConfig.processors].map((p) => p.forceFlush()),
    );
    assert.equal(spans.getFinishedSpans()[0]?.name, "manual");
    assert.equal(records.getFinishedLogRecords()[0]?.eventName, "manual");
    assert.equal("forceFlush" in telemetry, false);
  } finally {
    try {
      await telemetry.shutdown();
    } finally {
      trace.disable();
      logs.disable();
      propagation.disable();
      context.disable();
      diag.disable();
    }
  }
}

test("the only initializer is the upstream combined SDK", async () => {
  const distro = await import(pkg.name);
  assert.equal(distro.useMicrosoftOpenTelemetry, startBrowserSdk);
  assert.deepEqual(Object.keys(distro).sort(), [
    "OPENTELEMETRY_BROWSER_VERSION",
    "useMicrosoftOpenTelemetry",
  ]);
});

test("the root ESM initializer exports both traces and logs", async () => {
  const distro = await import(pkg.name);
  assert.equal(distro.OPENTELEMETRY_BROWSER_VERSION, pkg.version);
  await exerciseNpmPackage(distro);
});

test("using the initializer includes both SDKs and their default exporters", async () => {
  const chunk = await bundleConsumer('export { useMicrosoftOpenTelemetry } from "distro";');
  const modules = Object.entries(chunk.modules)
    .filter(([, module]) => module.renderedLength > 0)
    .map(([id]) => id.replaceAll("\\", "/"));
  for (const name of [
    "sdk-trace",
    "sdk-logs",
    "exporter-trace-otlp-http",
    "exporter-logs-otlp-http",
  ]) {
    assert.ok(
      modules.some((id) => id.includes(`/@opentelemetry/${name}/`)),
      `${name} must be included by the combined initializer`,
    );
  }
});

test("the package does not expose a CommonJS entry point", () => {
  assert.throws(() => require(pkg.name), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});

test("version-only and bare imports can tree-shake all SDKs", async () => {
  for (const source of [
    'export { OPENTELEMETRY_BROWSER_VERSION } from "distro";',
    'import "distro";',
  ]) {
    const chunk = await bundleConsumer(source);
    assert.ok(
      Object.entries(chunk.modules)
        .filter(([, module]) => module.renderedLength > 0)
        .every(([id]) => !id.includes("node_modules")),
    );
    if (source.startsWith("import")) assert.equal(chunk.code.trim(), "");
    else assert.match(chunk.code, /OPENTELEMETRY_BROWSER_VERSION/);
  }
});

test("the root entry ships the combined initializer's declarations", async () => {
  const declaration = await readFile(new URL(pkg.exports["."].import.types, root), "utf8");
  for (const name of ["OPENTELEMETRY_BROWSER_VERSION", "useMicrosoftOpenTelemetry"])
    assert.match(declaration, new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`));
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
    const sdk = distro.useMicrosoftOpenTelemetry({ disabled: true });
    assert.equal("forceFlush" in sdk, false);
    await sdk.shutdown();
  });
}

test("Terser produces a smaller ESM bundle", async () => {
  const [standard, minified] = await Promise.all([
    bundleConsumer('export * from "distro";'),
    readFile(new URL(`${esmBundle}.min.js`, root)),
  ]);
  assert.ok(minified.byteLength < Buffer.byteLength(standard.code));
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
    plugins: [nodeResolve({ browser: true }), commonjs()],
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
  const files = await readdir(new URL("dist/esm/", root));
  for (const file of files.filter((path) => path.endsWith(".js"))) {
    const url = new URL(`dist/esm/${file.replaceAll("\\", "/")}`, root);
    const code = await readFile(url, "utf8");
    assert.ok(code.includes(`//# sourceMappingURL=${url.pathname.split("/").at(-1)}.map`));
    const sourceMap = JSON.parse(await readFile(new URL(`${url}.map`), "utf8"));
    assert.equal(sourceMap.version, 3);
    assert.ok(sourceMap.sources.length > 0);
    assert.ok(sourceMap.sourcesContent.some((source) => typeof source === "string" && source));
  }
});
