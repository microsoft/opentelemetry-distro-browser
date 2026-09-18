import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import typescript from "@rollup/plugin-typescript";
import { dts } from "rollup-plugin-dts";
import { visualizer } from "rollup-plugin-visualizer";

const browserOutput = {
  format: "iife",
  name: "OpenTelemetryBrowser",
  sourcemap: true,
};

export default [
  {
    input: "src/index.ts",
    plugins: [
      nodeResolve({ browser: true }),
      commonjs(),
      typescript({ tsconfig: "./tsconfig.src.json" }),
    ],
    output: [
      {
        file: "dist/esm/index.js",
        format: "es",
        sourcemap: true,
      },
      {
        file: "dist/commonjs/index.cjs",
        format: "cjs",
        sourcemap: true,
      },
      {
        ...browserOutput,
        file: "dist/browser/opentelemetry-distro-browser.js",
      },
      {
        ...browserOutput,
        file: "dist/browser/opentelemetry-distro-browser.min.js",
        plugins: [
          terser(),
          visualizer({
            filename: "reports/bundle-stats.html",
            title: "OpenTelemetry browser bundle",
            template: "treemap",
            sourcemap: true,
            gzipSize: true,
            brotliSize: true,
          }),
        ],
      },
    ],
  },
  {
    input: "src/index.ts",
    plugins: [dts({ tsconfig: "./tsconfig.src.json" })],
    output: [
      {
        file: "dist/esm/index.d.ts",
        format: "es",
      },
      {
        file: "dist/commonjs/index.d.cts",
        format: "es",
      },
    ],
  },
];
