# Milestone M2 - Planning

Provide a supported browser artifact and a copy/paste setup path for applications that do not use a
bundler.

Status: complete except validation against exact supported browser versions, which waits on the M1
browser matrix. `0.1.0-beta.1` is published at `js.monitor.azure.com/scripts/otel/beta/`.

## Work items

| Item | M2 outcome | Status |
| --- | --- | --- |
| Browser bundle | Build the production browser bundle from the supported distribution for the declared browser matrix and enforce minified, gzip and Brotli budgets. | Done except exact browser versions. UMD and IIFE SDK and instrumentation bundles, alongside CommonJS npm entries, are tested in Chromium, Firefox and WebKit (#56), with blocking budgets and an ES2022 syntax check (#84). The CDN bundle carries every instrumentation, and build tests load each CDN file in a worker realm and compare its global API with the npm exports (#112). Validation against exact supported browser versions waits on the M1 browser matrix. |
| CDN publishing | Publish each release at an immutable versioned CDN URL and make the URL available with the release artifacts. Integrity, caching, CSP, cross-origin loading and load-failure checks are acceptance criteria for this deliverable. | Done. `npm run build` prepares versioned `js.monitor.azure.com/scripts/otel/<channel>/` files with source maps, `integrity.json` and a size badge (#112), `npm run cdn:publish` uploads them with immutable caching, and a plain HTML integration test covers SRI, CSP, cross-origin loading and load failures in Chromium, Firefox and WebKit. `0.1.0-alpha.3` (#86, #90) and `0.1.0-beta.1` (#125) are published, and the README documents CDN setup (#95). |
| Initialization snippet | Generate a concise copy/paste asynchronous snippet that loads the versioned bundle, applies connection and consent configuration, starts the distribution, and reports initialization success and failure. | Done. `getSdkLoaderScript()` on `./snippet` (#53) loads this package version's CDN bundle by default, or a caller-supplied IIFE bundle, with optional SRI, and exposes initialization as the `window.microsoftOpenTelemetry` promise. JSON settings pass sampling, Beacon, `session`, `userContext`, page-view, instrumentation and resource options, so storage consent is configurable from the snippet (#115). |

M2 does not add legacy tracking APIs or speculative loader and fallback variants.
