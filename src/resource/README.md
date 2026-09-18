# Browser resource detector

`BrowserDetector` implements the `ResourceDetector` interface from
`@opentelemetry/resources` and populates the OpenTelemetry
[`browser` resource attributes](https://opentelemetry.io/docs/specs/semconv/resource/browser/).

Detection is synchronous — every source is a synchronous browser global — so
`detect()` returns a plain `DetectedResource`.

## Detected attributes

| Attribute             | Type       | Source                                                                                                   |
| --------------------- | ---------- | -------------------------------------------------------------------------------------------------------- |
| `browser.brands`      | `string[]` | `navigator.userAgentData.brands`, each entry formatted `` `${brand} ${version}` `` (e.g. `Chromium 120`) |
| `browser.platform`    | `string`   | `navigator.userAgentData.platform`                                                                       |
| `browser.mobile`      | `boolean`  | `navigator.userAgentData.mobile`                                                                         |
| `browser.language`    | `string`   | `navigator.language`                                                                                     |
| `user_agent.original` | `string`   | `navigator.userAgent`                                                                                    |

## Usage

```ts
import { browserDetector } from "@microsoft/opentelemetry-distro-browser";

const resource = browserDetector.detect();
```

## Behaviour notes

- **`userAgentData` is Chromium-only.** The User-Agent Client Hints API is not
  implemented by Firefox or Safari, so on those engines only
  `browser.language` and `user_agent.original` are emitted. That is expected
  and correct.
- **`navigator.platform` is deliberately not used as a fallback.** The
  semantic convention explicitly says the legacy `navigator.platform` must not
  be substituted for `browser.platform`: its values are inconsistent across
  browsers and do not match the platform vocabulary the convention defines.
- **Attributes are omitted, never faked.** Anything that cannot be determined
  is left out rather than emitted as an empty string, `null`, `undefined`, or
  `"unknown"`.
- **`browser.document.url.full` is not emitted.** The page URL changes during
  the page lifetime and is stamped per signal (upstream this is done by the
  document log record processor), so it does not belong on an immutable
  resource.
- **Safe outside a browser.** If `navigator` is undefined (SSR, Node
  prerendering, jsdom) the detector returns `{ attributes: {} }`. `window` is
  never referenced, so the detector also works in web workers.
- **Never throws.** It runs during SDK initialisation, so every access is
  guarded.

## Status

The code is vendor-neutral and written so it can be contributed verbatim
upstream to
[`open-telemetry/opentelemetry-browser`](https://github.com/open-telemetry/opentelemetry-browser),
whose SDK currently has no resource-detector support and populates no browser
resource attributes.

These files carry this repository's Microsoft MIT header. If and when the
detector is actually proposed upstream, it will be relicensed to Apache-2.0
with the standard OpenTelemetry SPDX header at that point.
