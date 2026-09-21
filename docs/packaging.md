# Browser package output

The [M0 build requirements](../planning/M0_WORK_BREAKDOWN.md#repository-build-and-tooling)
require ES2022 ESM-only output. `npm run build` cleans previous artifacts and emits:

| Artifact                 | Purpose                                                      |
| ------------------------ | ------------------------------------------------------------ |
| `dist/esm/index.js`      | Package entry point with external OpenTelemetry dependencies |
| `dist/esm/index.min.js`  | Bundled, minified ESM for browser size checks                |
| `dist/esm/index.d.ts`    | Public TypeScript declarations                               |
| `dist/esm/index*.js.map` | Source maps with embedded source content                     |

Import the package through its `exports` map. The manifest intentionally has no `main` or
`module` field and no CommonJS `require` condition. CommonJS consumers must use asynchronous
`import()`; synchronous `require()` of the package is not supported. The `package.json`
metadata subpath remains available.

There is no CommonJS build, `.d.cts` declaration, IIFE bundle, or `OpenTelemetryBrowser` global.
The former `dist/commonjs/` and `dist/browser/` outputs are removed. Browser consumers use an
ESM-aware bundler or native module imports, not a classic script tag expecting a global.
The npm entry leaves OpenTelemetry dependencies external to share the application's API
instances and platform resolution. Direct native browser loading of that entry requires an
import map for those dependencies; the minified bundle includes them.
CDN publication and loader policy remain deferred in the implementation plan.

`npm run test:build` checks the output inventory, package resolution, declaration consumption
with TypeScript NodeNext and Bundler resolution, source maps, minification, and tree shaking.
`npm run test:integration` checks manual telemetry through the npm entry in Chromium and
imports the minified bundle natively without a bundler transforming its contents.
The `sideEffects: false` contract remains in place; importing the package does not initialize
telemetry.

`npm run size` reports minified, gzip, and Brotli sizes for `dist/esm/index.min.js`.
`npm run size:report` writes the machine-readable report, and the production build generates
`reports/bundle-stats.html` for dependency analysis.
