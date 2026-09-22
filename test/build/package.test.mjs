import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
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
const sharedApiPackages = ["@opentelemetry/api", "@opentelemetry/api-logs"];

async function bundleConsumer(source, external = []) {
  const input = "\0consumer";
  const bundle = await rollup({
    input,
    external,
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
    assert.deepEqual(output[0].imports.sort(), [...external].sort());
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
  const options = {
    spanProcessors: [new SimpleSpanProcessor(spans)],
    logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: records })],
  };
  const telemetry = distro.useMicrosoftOpenTelemetry(options);
  try {
    tracer.startSpan("manual").end();
    logger.emit({ eventName: "manual" });
    await Promise.all(
      [...options.spanProcessors, ...options.logRecordProcessors].map((p) => p.forceFlush()),
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

test("the only initializer is a distro-owned wrapper", async () => {
  const distro = await import(pkg.name);
  assert.notEqual(distro.useMicrosoftOpenTelemetry, startBrowserSdk);
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

test("explicit OTLP export runs alongside custom processors", async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        path: request.url,
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  t.after(() => {
    trace.disable();
    logs.disable();
    propagation.disable();
    context.disable();
    diag.disable();
  });

  const distro = await import(pkg.name);
  const spans = new InMemorySpanExporter();
  const records = new InMemoryLogRecordExporter();
  const spanProcessors = Object.freeze([new SimpleSpanProcessor(spans)]);
  const logRecordProcessors = Object.freeze([new SimpleLogRecordProcessor({ exporter: records })]);
  const otlp = Object.freeze({
    endpoint: `http://127.0.0.1:${server.address().port}`,
    headers: Object.freeze({ "x-tenant": "checkout" }),
  });
  const telemetry = distro.useMicrosoftOpenTelemetry({
    otlp,
    spanProcessors,
    logRecordProcessors,
  });
  try {
    trace.getTracer("additive-export").startSpan("checkout").end();
    logs.getLogger("additive-export").emit({ eventName: "checkout.started" });
    await Promise.all([...spanProcessors, ...logRecordProcessors].map((p) => p.forceFlush()));
    assert.equal(spans.getFinishedSpans()[0]?.name, "checkout");
    assert.equal(records.getFinishedLogRecords()[0]?.eventName, "checkout.started");
  } finally {
    await telemetry.shutdown();
  }

  assert.deepEqual(requests.map((request) => request.path).sort(), ["/v1/logs", "/v1/traces"]);
  for (const request of requests) assert.equal(request.headers["x-tenant"], "checkout");
  const traceRequest = requests.find((request) => request.path === "/v1/traces");
  const logRequest = requests.find((request) => request.path === "/v1/logs");
  assert.equal(traceRequest.body.resourceSpans[0].scopeSpans[0].spans[0].name, "checkout");
  assert.equal(
    logRequest.body.resourceLogs[0].scopeLogs[0].logRecords[0].eventName,
    "checkout.started",
  );
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

test("the minified artifact keeps both API packages external", async () => {
  const bundle = await rollup({
    input: fileURLToPath(new URL(`${esmBundle}.min.js`, root)),
    external: sharedApiPackages,
    onwarn(warning) {
      throw new Error(warning.message);
    },
  });
  try {
    const { output } = await bundle.generate({ format: "es" });
    assert.deepEqual(output[0].imports.sort(), sharedApiPackages);
    const map = JSON.parse(await readFile(new URL(`${esmBundle}.min.js.map`, root), "utf8"));
    assert.ok(
      map.sources.every(
        (source) => !/\/@opentelemetry\/api(?:-logs)?\//.test(source.replaceAll("\\", "/")),
      ),
      "API implementations must not be embedded in the minified SDK bundle",
    );
  } finally {
    await bundle.close();
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
    await exerciseNpmPackage(distro);
  });
}

test("Terser produces a smaller ESM bundle", async () => {
  const [standard, minified] = await Promise.all([
    bundleConsumer('export * from "distro";', sharedApiPackages),
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
