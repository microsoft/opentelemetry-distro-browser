# OpenTelemetry distribution for the browser

TypeScript project skeleton for a browser-focused OpenTelemetry distribution. The layout follows
[`opentelemetry-distro-javascript`](https://github.com/microsoft/opentelemetry-distro-javascript),
with Rollup bundling and Terser minification for browser delivery.

The only runtime export is currently `OPENTELEMETRY_BROWSER_VERSION`. Telemetry initialization,
instrumentations, and exporters are not implemented yet. The npm package is marked private until
it is ready to publish.

## Planning and proof of concept

The upstream design documents and standalone proof of concept are preserved alongside the skeleton:

- [Implementation plan](planning/IMPLEMENTATION_PLAN.md)
- [M0 work breakdown](planning/M0_WORK_BREAKDOWN.md)
- [Architecture](planning/ARCHITECTURE.md)
- [Requirements](planning/REQUIREMENTS.md)
- [Milestones](planning/MILESTONES.md)
- [Multi-instance browser PoC](poc/README.md) and its [size report](poc/SIZE_REPORT.md)

These documents describe the proposed product and future milestones, rather than APIs implemented
in the root package today. The PoC has its own npm manifest, dependencies, and commands; follow
its README to build and test it independently. Root lint and format commands exclude `poc/`, and
formatting leaves the existing planning documents unchanged.

## Development

Use Node.js 22.22.2+ (22.x), 24.15.0+ (24.x), or 26+, with npm 10 or newer.

```sh
npm ci
npm run test:install-browsers
npm run check
```

Commit `package-lock.json` whenever dependencies change. Use `npm install` to update dependencies
and `npm ci` for a reproducible installation. The project `.npmrc` omits registry-specific URLs
from the lockfile so contributors and CI can use their configured npm registry; package versions
and integrity hashes remain locked.

| Command                         | Purpose                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `npm run build`                 | Build bundles, declarations, source maps, and bundle visualization |
| `npm run clean`                 | Remove builds, bundle reports, and temporary API reports           |
| `npm run typecheck`             | Check source, tests, and Vitest configuration                      |
| `npm run lint`                  | Run ESLint with no warnings allowed                                |
| `npm run lint:fix`              | Apply ESLint fixes                                                 |
| `npm run format`                | Check formatting with Prettier                                     |
| `npm run format:check`          | Alias for the formatting check                                     |
| `npm run format:fix`            | Apply Prettier formatting                                          |
| `npm test`                      | Run Vitest unit tests once in Chromium                             |
| `npm run test:unit`             | Run Chromium unit tests under `test/internal/unit/`                |
| `npm run test:integration`      | Test built browser scripts in Chromium; build first                |
| `npm run test:install-browsers` | Install the Playwright Chromium browser                            |
| `npm run test:watch`            | Run Vitest in watch mode                                           |
| `npm run test:coverage`         | Run unit tests with V8 coverage                                    |
| `npm run test:build`            | Smoke-test built bundles and declarations; build first             |
| `npm run api:check`             | Compare the public API with its baseline; build first              |
| `npm run api:update`            | Build and intentionally update the public API baseline             |
| `npm run size`                  | Report minified, gzip, and Brotli bundle sizes; build first        |
| `npm run size:report`           | Write bundle sizes to `reports/bundle-size.json`; build first      |
| `npm run check`                 | Run all quality, browser, build, API, and size checks              |

Vitest Browser Mode uses Playwright to run unit and integration tests in real headless Chromium.
Install the browser after `npm ci`, and again after Playwright upgrades. On Linux, use
`npm run test:install-browsers -- --with-deps` to also install required system libraries.
Unit tests work without a build; integration tests execute the generated standard and minified
browser scripts in isolated browser frames and require `npm run build` first.

Coverage reports are written to `coverage/`. Source TypeScript uses DOM types without Node.js globals,
while tests and tooling can use Node.js types.

ESLint applies type-aware and security rules to the package source under `src/`, including checks
for floating promises, misused promises, and non-null assertions.

## Project structure

```text
.github/workflows/     Pull-request CI
etc/                   Public API report baseline
planning/              Product design and milestone documents
poc/                   Standalone multi-instance browser proof of concept
scripts/               Cross-platform build helpers
src/
  index.ts             Public package entry point
  shared/              Shared constants and utilities
test/
  internal/unit/       Vitest unit tests
  integration/         Built browser scripts tested in Chromium
  build/               Built-package smoke tests
api-extractor.json    Public API report configuration
.size-limit.json      Bundle-size reporting configuration
rollup.config.mjs      JavaScript bundles and TypeScript declarations
tsconfig*.json         Shared, source, and test TypeScript settings
vitest*.config.ts      Shared, unit, and integration Vitest settings
```

## Build outputs

| Output                                             | Format                       |
| -------------------------------------------------- | ---------------------------- |
| `dist/esm/index.js`                                | ES module                    |
| `dist/esm/index.d.ts`                              | ES module declarations       |
| `dist/commonjs/index.cjs`                          | CommonJS                     |
| `dist/commonjs/index.d.cts`                        | CommonJS declarations        |
| `dist/browser/opentelemetry-distro-browser.js`     | Browser IIFE                 |
| `dist/browser/opentelemetry-distro-browser.min.js` | Terser-minified browser IIFE |

Every JavaScript bundle has a source map. Package exports select the appropriate JavaScript and
declarations for `import` and `require`. Browser bundles expose the `OpenTelemetryBrowser` global:

```html
<script src="./dist/browser/opentelemetry-distro-browser.min.js"></script>
<script>
  console.log(OpenTelemetryBrowser.OPENTELEMETRY_BROWSER_VERSION);
</script>
```

## Public API validation

API Extractor compares the built ES module declarations against
`etc/opentelemetry-distro-browser.api.md`. `npm run api:check` fails when the generated report
differs from the baseline; CI never updates the baseline automatically.

For an intentional API change, run `npm run api:update`, review the report diff, and include it
in the pull request. This makes API changes visible for review ahead of a beta API stability
commitment; it does not by itself prohibit breaking changes or enforce reviewer approval.
Only the basic API report is enabled. Rollup continues to generate the package declarations.

## Bundle-size reporting

Size Limit measures the actual Terser-minified browser output without rebundling it. `npm run size`
reports uncompressed, gzip, and Brotli sizes. `npm run size:report` writes the same measurements as
JSON to `reports/bundle-size.json`.

Every build also creates `reports/bundle-stats.html` with Rollup Visualizer. Open it in a browser
to inspect which modules contribute to the minified bundle; source maps provide module attribution.
The visualizer's per-module compression estimates need not sum to the compressed bundle size.

CI uploads both reports as downloadable artifacts. Reports are not included in the npm package.
Size reporting is informational for now: no arbitrary budget is imposed on the version-only
skeleton. Once there is a representative minimum product, set reviewed `limit` values in
`.size-limit.json` to make budget violations fail CI. Rollup and Terser remain the chosen tools,
with their size advantage to be reassessed against that product.

## Continuous integration

GitHub Actions runs on every pull request, pushes to `main`, and manual dispatches. It checks
ESLint, Prettier, and TypeScript, then runs Vitest unit tests with coverage in Chromium and builds
the Rollup/Terser outputs on Node.js 22 and 24. Build smoke tests verify ES module and CommonJS
imports, browser globals, minification, declarations, and source maps. Browser integration tests
execute the built scripts in Chromium. CI also checks the API report, reports bundle sizes,
uploads the size/visualizer artifacts, and checks npm package contents with `npm pack --dry-run`.

To require these checks before merging, configure branch protection or a repository ruleset for
`main` after the workflow has run. Workflow files alone do not prevent merging a failing PR.

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit
[Contributor License Agreements](https://cla.opensource.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide a
CLA and decorate the pull request appropriately. You only need to do this once across repositories
using this CLA.

This project has adopted the
[Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/). For more
information, see the
[Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or contact
[opencode@microsoft.com](mailto:opencode@microsoft.com).

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of
Microsoft trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion
or imply Microsoft sponsorship. Any use of third-party trademarks or logos is subject to those third
parties' policies.
