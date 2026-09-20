import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { rollup } from "rollup";

const root = new URL("../../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const require = createRequire(import.meta.url);
const browserBundle = "dist/browser/opentelemetry-distro-browser";

async function exerciseNpmPackage(distro) {
  const spans = new InMemorySpanExporter();
  const records = new InMemoryLogRecordExporter();
  const tracer = trace.getTracer("package-consumer");
  const logger = logs.getLogger("package-consumer");
  const telemetry = distro.useMicrosoftOpenTelemetry({
    spanProcessors: [new SimpleSpanProcessor(spans)],
    logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: records })],
  });
  try {
    tracer.startSpan("manual").end();
    logger.emit({ eventName: "manual" });
    await telemetry.forceFlush();
    assert.equal(spans.getFinishedSpans()[0]?.name, "manual");
    assert.equal(records.getFinishedLogRecords()[0]?.eventName, "manual");
    const shutdown = telemetry.shutdown();
    assert.equal(telemetry.shutdown(), shutdown);
    await shutdown;
  } finally {
    await telemetry.shutdown();
  }
  assert.throws(
    () => distro.useMicrosoftOpenTelemetry({ otlp: { endpoint: "https://example.com" } }),
    /Destination presets are not implemented/,
  );
}

test("the package can be imported as ES modules", async () => {
  const distro = await import(pkg.name);
  assert.equal(distro.OPENTELEMETRY_BROWSER_VERSION, pkg.version);
  await exerciseNpmPackage(distro);
});

test("the package can be required as CommonJS", async () => {
  const distro = require(pkg.name);
  assert.equal(distro.OPENTELEMETRY_BROWSER_VERSION, pkg.version);
  await exerciseNpmPackage(distro);
});

for (const suffix of [".js", ".min.js"]) {
  test(`the browser ${suffix} bundle runs without Node.js globals`, async () => {
    const code = await readFile(new URL(`${browserBundle}${suffix}`, root), "utf8");
    const context = { performance, crypto, setTimeout, clearTimeout };
    runInNewContext(code, context);
    assert.equal(context.OpenTelemetryBrowser.OPENTELEMETRY_BROWSER_VERSION, pkg.version);
    let flushes = 0;
    let shutdowns = 0;
    const lifecycle = {
      async forceFlush() {
        flushes++;
      },
      async shutdown() {
        shutdowns++;
      },
    };
    const telemetry = context.OpenTelemetryBrowser.useMicrosoftOpenTelemetry({
      spanProcessors: [{ ...lifecycle, onStart() {}, onEnd() {} }],
      logRecordProcessors: [{ ...lifecycle, onEmit() {} }],
    });
    try {
      await telemetry.forceFlush();
      assert.equal(flushes, 2);
      await telemetry.shutdown();
      assert.equal(shutdowns, 2);
    } finally {
      await telemetry.shutdown();
    }
    assert.equal("process" in context, false);
    assert.equal("require" in context, false);
    assert.throws(
      () => context.OpenTelemetryBrowser.useMicrosoftOpenTelemetry({ azureMonitor: {} }),
      /Destination presets are not implemented/,
    );
  });
}

test("Terser produces a smaller browser bundle", async () => {
  const [standard, minified] = await Promise.all(
    [".js", ".min.js"].map((suffix) => readFile(new URL(`${browserBundle}${suffix}`, root))),
  );
  assert.ok(minified.byteLength < standard.byteLength);
});

for (const [name, source] of [
  [
    "a version-only import excludes the SDKs",
    'export { OPENTELEMETRY_BROWSER_VERSION } from "distro";',
  ],
  ["a bare side-effect import produces no code", 'import "distro";'],
]) {
  test(name, async () => {
    const entry = "\0consumer";
    const bundle = await rollup({
      input: entry,
      plugins: [
        {
          name: "package-consumer",
          resolveId(id) {
            if (id === entry) return entry;
            if (id === "distro")
              return fileURLToPath(new URL(pkg.exports["."].import.default, root));
          },
          load(id) {
            if (id === entry) return source;
          },
        },
        nodeResolve({ browser: true }),
        commonjs(),
      ],
      onwarn(warning, defaultHandler) {
        if (warning.code !== "EMPTY_BUNDLE") defaultHandler(warning);
      },
    });
    try {
      const { output } = await bundle.generate({ format: "es" });
      const chunk = output[0];
      assert.equal(chunk.type, "chunk");
      assert.doesNotMatch(chunk.code, /useMicrosoftOpenTelemetry|No processors configured/);
      const renderedModules = Object.entries(chunk.modules).filter(
        ([, module]) => module.renderedLength > 0,
      );
      assert.ok(renderedModules.every(([id]) => !id.includes("node_modules")));
      if (source.startsWith("import")) assert.equal(chunk.code.trim(), "");
      else assert.match(chunk.code, /OPENTELEMETRY_BROWSER_VERSION/);
    } finally {
      await bundle.close();
    }
  });
}

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
