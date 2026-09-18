import { build } from "vite";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const tmp = resolve(here, ".tmp");

/**
 * Bundle size is the binding constraint for a browser distribution, so it is measured rather
 * than estimated. Every scenario is a real Vite production build of a real entry point: the
 * same bundler, minifier and target the distribution itself would ship with.
 *
 * Numbers are only comparable to each other. They are not comparable to the size badge on an
 * npm package page, which measures the published tarball rather than the tree-shaken,
 * minified bytes that reach a browser.
 */
const SHARED_IMPORTS = `
import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
`;

const SDK_IMPORTS = `
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from "@opentelemetry/core";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { StackContextManager } from "@opentelemetry/sdk-trace-web";
import { resourceFromAttributes } from "@opentelemetry/resources";
`;

const BRIDGE_IMPORTS = `
import { installMultiInstanceBridge } from "../../src/multi-instance-provider";
`;

/** Referenced through a global so nothing under measurement is tree-shaken away. */
const sink = (...names) => `globalThis.__sizeSink = [${names.join(", ")}];\n`;

const BRIDGE_SINK = [
    "trace", "context", "propagation", "diag", "logs",
    "BasicTracerProvider", "BatchSpanProcessor", "LoggerProvider", "BatchLogRecordProcessor",
    "StackContextManager", "CompositePropagator", "W3CTraceContextPropagator",
    "W3CBaggagePropagator", "resourceFromAttributes", "installMultiInstanceBridge"
];

const api = {
    id: "api",
    label: "OpenTelemetry API only (trace + logs)",
    group: "baseline",
    code: SHARED_IMPORTS + sink("trace", "context", "propagation", "diag", "logs")
};

const sdk = {
    id: "sdk",
    label: "+ SDK (providers, batch processors, W3C propagators)",
    group: "baseline",
    code: SHARED_IMPORTS + SDK_IMPORTS + sink(...BRIDGE_SINK.slice(0, -1))
};

const bridge = {
    id: "bridge",
    label: "+ multi-instance bridge (this repo)",
    group: "baseline",
    code: SHARED_IMPORTS + SDK_IMPORTS + BRIDGE_IMPORTS + sink(...BRIDGE_SINK)
};

/** Each is measured on top of the `bridge` baseline, so the delta is that package alone. */
const ADDITIONS = [
    {
        id: "instrumentation-base",
        label: "@opentelemetry/instrumentation (base class only)",
        group: "instrumentation",
        code: `import { InstrumentationBase } from "@opentelemetry/instrumentation";`,
        symbols: ["InstrumentationBase"]
    },
    {
        id: "navigation",
        label: "@opentelemetry/browser-instrumentation/experimental/navigation",
        group: "instrumentation",
        code: `import { NavigationInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation";`,
        symbols: ["NavigationInstrumentation"]
    },
    {
        id: "navigation-timing",
        label: "@opentelemetry/browser-instrumentation/experimental/navigation-timing",
        group: "instrumentation",
        code: `import { NavigationTimingInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/navigation-timing";`,
        symbols: ["NavigationTimingInstrumentation"]
    },
    {
        id: "resource-timing",
        label: "@opentelemetry/browser-instrumentation/experimental/resource-timing",
        group: "instrumentation",
        code: `import { ResourceTimingInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/resource-timing";`,
        symbols: ["ResourceTimingInstrumentation"]
    },
    {
        id: "user-action",
        label: "@opentelemetry/browser-instrumentation/experimental/user-action",
        group: "instrumentation",
        code: `import { UserActionInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/user-action";`,
        symbols: ["UserActionInstrumentation"]
    },
    {
        id: "web-vitals",
        label: "@opentelemetry/browser-instrumentation/experimental/web-vitals",
        group: "instrumentation",
        code: `import { WebVitalsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/web-vitals";`,
        symbols: ["WebVitalsInstrumentation"]
    },
    {
        id: "errors",
        label: "@opentelemetry/browser-instrumentation/experimental/errors",
        group: "instrumentation",
        code: `import { ErrorsInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/errors";`,
        symbols: ["ErrorsInstrumentation"]
    },
    {
        id: "console",
        label: "@opentelemetry/browser-instrumentation/experimental/console",
        group: "instrumentation",
        code: `import { ConsoleInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/console";`,
        symbols: ["ConsoleInstrumentation"]
    },
    {
        id: "fetch",
        label: "@opentelemetry/browser-instrumentation/experimental/fetch",
        group: "instrumentation",
        code: `import { FetchInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/fetch";`,
        symbols: ["FetchInstrumentation"]
    },
    {
        id: "xhr",
        label: "@opentelemetry/browser-instrumentation/experimental/xhr",
        group: "instrumentation",
        code: `import { XhrInstrumentation } from "@opentelemetry/browser-instrumentation/experimental/xhr";`,
        symbols: ["XhrInstrumentation"]
    },
    {
        id: "otlp-http-traces",
        label: "@opentelemetry/exporter-trace-otlp-http",
        group: "exporter",
        code: `import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";`,
        symbols: ["OTLPTraceExporter"]
    },
    {
        id: "otlp-http-logs",
        label: "@opentelemetry/exporter-logs-otlp-http",
        group: "exporter",
        code: `import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";`,
        symbols: ["OTLPLogExporter"]
    },
    {
        id: "semantic-conventions",
        label: "@opentelemetry/semantic-conventions (one stable attribute)",
        group: "other",
        code: `import { ATTR_EXCEPTION_MESSAGE } from "@opentelemetry/semantic-conventions";`,
        symbols: ["ATTR_EXCEPTION_MESSAGE"]
    }
];

const additionScenarios = ADDITIONS.map((addition) => ({
    id: `bridge-plus-${addition.id}`,
    label: addition.label,
    group: addition.group,
    addition: addition.id,
    code: SHARED_IMPORTS + SDK_IMPORTS + BRIDGE_IMPORTS + addition.code + "\n"
        + sink(...BRIDGE_SINK, ...addition.symbols)
}));

const everything = {
    id: "full",
    label: "Everything the PoC bundles",
    group: "total",
    code: SHARED_IMPORTS + SDK_IMPORTS + BRIDGE_IMPORTS
        + ADDITIONS.map((a) => a.code).join("\n") + "\n"
        + sink(...BRIDGE_SINK, ...ADDITIONS.flatMap((a) => a.symbols))
};

const SCENARIOS = [api, sdk, bridge, ...additionScenarios, everything];

async function measure(scenario) {
    const entry = resolve(tmp, `${scenario.id}.ts`);
    writeFileSync(entry, scenario.code, "utf8");

    const result = await build({
        root,
        logLevel: "error",
        configFile: false,
        build: {
            write: false,
            target: "es2020",
            minify: true,
            codeSplitting: false,
            lib: { entry, formats: ["es"], fileName: "bundle" }
        }
    });

    const output = Array.isArray(result) ? result[0].output : result.output;
    const code = output
        .filter((chunk) => chunk.type === "chunk")
        .map((chunk) => chunk.code)
        .join("");
    const raw = Buffer.from(code, "utf8");

    return {
        ...scenario,
        raw: raw.byteLength,
        gzip: gzipSync(raw, { level: 9 }).byteLength,
        brotli: brotliCompressSync(raw, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
        }).byteLength
    };
}

const kb = (bytes) => `${(bytes / 1024).toFixed(2)} kB`;
const delta = (bytes) => `${bytes >= 0 ? "+" : "-"}${(Math.abs(bytes) / 1024).toFixed(2)} kB`;

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const measured = [];
for (const scenario of SCENARIOS) {
    process.stderr.write(`measuring ${scenario.id}\n`);
    measured.push(await measure(scenario));
}
rmSync(tmp, { recursive: true, force: true });

const byId = new Map(measured.map((m) => [m.id, m]));
const baseline = byId.get("bridge");
const full = byId.get("full");

const lines = [];
lines.push("# PoC bundle size");
lines.push("");
lines.push("Generated by `npm run size`. Every row is a real Vite production build of a real entry");
lines.push("point, minified and targeting `es2020`, which is the same pipeline the PoC itself builds");
lines.push("with (Vite 8, rolldown and the oxc minifier).");
lines.push("");
lines.push("These numbers are only comparable to each other. They are **not** comparable to the size");
lines.push("shown on an npm package page, which measures a published tarball rather than the");
lines.push("tree-shaken, minified bytes that reach a browser.");
lines.push("");
lines.push(`Measured on ${new Date().toISOString().slice(0, 10)}.`);
lines.push("");
lines.push("## Baseline layers");
lines.push("");
lines.push("| Layer | Raw | Gzip | Brotli | Gzip delta |");
lines.push("|---|---:|---:|---:|---:|");

let previous = null;
for (const id of ["api", "sdk", "bridge"]) {
    const row = byId.get(id);
    lines.push(`| ${row.label} | ${kb(row.raw)} | ${kb(row.gzip)} | ${kb(row.brotli)} | ${previous ? delta(row.gzip - previous.gzip) : "-"} |`);
    previous = row;
}

lines.push("");
lines.push("## Marginal cost of each addition");
lines.push("");
lines.push(`Each row is built on top of the bridge baseline (${kb(baseline.gzip)} gzip), so the delta`);
lines.push("is the cost of that package alone, including any dependency it pulls in that the baseline");
lines.push("did not already have.");
lines.push("");

const GROUP_TITLES = {
    instrumentation: "Instrumentation",
    exporter: "Exporter",
    other: "Other"
};

for (const group of ["instrumentation", "exporter", "other"]) {
    const rows = measured.filter((m) => m.group === group && m.addition);
    if (rows.length === 0) {
        continue;
    }
    lines.push(`### ${GROUP_TITLES[group]}`);
    lines.push("");
    lines.push("| Package | Gzip delta | Brotli delta | Total gzip |");
    lines.push("|---|---:|---:|---:|");
    for (const row of [...rows].sort((a, b) => b.gzip - a.gzip)) {
        lines.push(`| \`${row.label}\` | ${delta(row.gzip - baseline.gzip)} | ${delta(row.brotli - baseline.brotli)} | ${kb(row.gzip)} |`);
    }
    lines.push("");
}

const sumOfParts = measured
    .filter((m) => m.addition)
    .reduce((total, m) => total + (m.gzip - baseline.gzip), 0);

lines.push("## Everything together");
lines.push("");
lines.push("| Bundle | Raw | Gzip | Brotli |");
lines.push("|---|---:|---:|---:|");
lines.push(`| ${full.label} | ${kb(full.raw)} | ${kb(full.gzip)} | ${kb(full.brotli)} |`);
lines.push("");
lines.push(`Adding the baseline to the sum of the individual deltas gives ${kb(baseline.gzip + sumOfParts)} gzip,`);
lines.push(`against ${kb(full.gzip)} measured for the combined bundle. The difference is shared`);
lines.push("dependencies being counted once instead of once per package, which is why per-package");
lines.push("numbers must never simply be added up.");

const report = lines.join("\n");
writeFileSync(resolve(root, "SIZE_REPORT.md"), report + "\n", "utf8");
process.stdout.write(report + "\n");
