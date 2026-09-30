import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";

const samplesRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(samplesRoot, "..");
const outputPath = resolve(samplesRoot, "telemetry-viewer", "public", "build-info.json");

async function measure(path) {
  const source = await readFile(path);
  return {
    rawBytes: source.byteLength,
    gzipBytes: gzipSync(source).byteLength,
    brotliBytes: brotliCompressSync(source).byteLength,
  };
}

const buildInfo = {
  source: "dist/esm",
  unminified: await measure(resolve(repositoryRoot, "dist", "esm", "index.js")),
  minified: await measure(resolve(repositoryRoot, "dist", "esm", "index.min.js")),
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
