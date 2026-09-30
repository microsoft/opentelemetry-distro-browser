import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { rollup } from "rollup";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const input = "\0telemetry-viewer-size";
const packageEntry = resolve(root, "dist", "esm", "index.js");
const outputPath = resolve(root, "samples", "telemetry-viewer", "public", "build-info.json");

function measure(code) {
  return {
    rawBytes: Buffer.byteLength(code),
    gzipBytes: gzipSync(code, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(code, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
}

async function generateCode(bundle, plugins = []) {
  const { output } = await bundle.generate({ format: "es", plugins });
  const chunk = output.find((item) => item.type === "chunk" && item.isEntry);
  if (!chunk) throw new Error("The bundle-size build did not produce an entry chunk.");
  return chunk.code;
}

const bundle = await rollup({
  input,
  external: ["@opentelemetry/api", "@opentelemetry/api-logs"],
  plugins: [
    {
      name: "telemetry-viewer-size-entry",
      resolveId(id) {
        if (id === input) return input;
        if (id === "@microsoft/opentelemetry-browser") return packageEntry;
      },
      load(id) {
        if (id === input) return 'export * from "@microsoft/opentelemetry-browser";';
      },
    },
    nodeResolve({ browser: true }),
    commonjs(),
  ],
  onwarn(warning, defaultHandler) {
    if (warning.code === "UNRESOLVED_IMPORT") throw new Error(warning.message);
    defaultHandler(warning);
  },
});

try {
  const unminifiedCode = await generateCode(bundle);
  const minifiedCode = await generateCode(bundle, [terser()]);
  const buildInfo = {
    source: "Complete browser distribution bundle (OpenTelemetry API packages external)",
    unminified: measure(unminifiedCode),
    minified: measure(minifiedCode),
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
} finally {
  await bundle.close();
}
