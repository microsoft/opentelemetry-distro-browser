# OpenTelemetry distribution for the browser

TypeScript project skeleton for a browser-focused OpenTelemetry distribution. The layout follows
[`opentelemetry-distro-javascript`](https://github.com/microsoft/opentelemetry-distro-javascript),
with Rollup bundling and Terser minification for browser delivery.

The only runtime export is currently `OPENTELEMETRY_BROWSER_VERSION`. Telemetry initialization,
instrumentations, and exporters are not implemented yet. The npm package is marked private until
it is ready to publish.

## Development

Use Node.js 22.22.2+ (22.x), 24.15.0+ (24.x), or 26+, with npm 10 or newer.

```sh
npm ci
npm run check
```

Commit `package-lock.json` whenever dependencies change. Use `npm install` to update dependencies
and `npm ci` for a reproducible installation. The project `.npmrc` omits registry-specific URLs
from the lockfile so contributors and CI can use their configured npm registry; package versions
and integrity hashes remain locked.

| Command                 | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `npm run build`         | Clean and build bundles, declarations, and source maps        |
| `npm run clean`         | Remove generated `dist/` outputs                              |
| `npm run typecheck`     | Check source, tests, and Vitest configuration                 |
| `npm run lint`          | Run ESLint with no warnings allowed                           |
| `npm run lint:fix`      | Apply ESLint fixes                                            |
| `npm run format`        | Check formatting with Prettier                                |
| `npm run format:fix`    | Apply Prettier formatting                                     |
| `npm test`              | Run Vitest tests once                                         |
| `npm run test:unit`     | Run unit tests under `test/internal/unit/`                    |
| `npm run test:watch`    | Run Vitest in watch mode                                      |
| `npm run test:coverage` | Run unit tests with V8 coverage                               |
| `npm run test:build`    | Smoke-test built bundles and declarations; build first        |
| `npm run check`         | Run formatting, lint, types, coverage, build, and smoke tests |

Vitest uses jsdom for a browser-like DOM environment; it does not launch a real browser.
Coverage reports are written to `coverage/`. Source TypeScript uses DOM types without Node.js
globals, while tests and tooling can use Node.js types.

## Project structure

```text
.github/workflows/     Pull-request CI
scripts/               Cross-platform build helpers
src/
  index.ts             Public package entry point
  shared/              Shared constants and utilities
test/
  internal/unit/       Vitest unit tests
  build/               Built-package smoke tests
rollup.config.mjs      JavaScript bundles and TypeScript declarations
tsconfig*.json         Shared, source, and test TypeScript settings
vitest*.config.ts      Shared and unit-test Vitest settings
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

## Continuous integration

GitHub Actions runs on every pull request, pushes to `main`, and manual dispatches. It checks
ESLint, Prettier, and TypeScript, then runs Vitest with coverage and builds the Rollup/Terser
outputs on Node.js 22 and 24. Build smoke tests verify ES module and CommonJS imports, browser
globals, minification, declarations, and source maps. CI also checks the npm package contents
with `npm pack --dry-run`.

To require these checks before merging, configure branch protection or a repository ruleset for
`main` after the workflow has run. Workflow files alone do not prevent merging a failing PR.

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit [Contributor License Agreements](https://cla.opensource.microsoft.com).

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
