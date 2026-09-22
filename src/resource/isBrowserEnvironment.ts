// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * The subset of a global scope needed to tell a browser scope from a server runtime.
 */
interface GlobalScopeLike {
  readonly window?: unknown;
  readonly WorkerGlobalScope?: unknown;
  readonly WorkerNavigator?: unknown;
}

/**
 * Reports whether `scope` is a browser global scope.
 *
 * @remarks
 * The presence of `navigator` is not evidence of a browser. Node 21 and later expose a `navigator`
 * global whose `userAgent` is `Node.js/<major>` and whose `language` and `platform` describe the
 * server; Deno and Bun expose one as well. Detecting there would stamp server values onto telemetry
 * produced during server-side rendering or prerendering, which is worse than emitting nothing.
 *
 * Browser scopes are therefore identified positively rather than by ruling individual runtimes out:
 * a document context provides `window`, and a worker scope provides `WorkerGlobalScope` in its
 * place.
 *
 * `WorkerGlobalScope` alone is not sufficient, because edge runtimes that implement the worker API
 * expose it too — Cloudflare Workers registers it as a global and reports a `navigator.userAgent`
 * of `Cloudflare-Workers` with a `navigator.language` of `en`, which would otherwise be recorded as
 * browser telemetry. A worker scope is accepted only when it also exposes `WorkerNavigator`, the
 * standardised browser worker navigator type; Cloudflare exposes a plain `Navigator` instead.
 *
 * `WorkerNavigator` is preferred over a capability check such as `indexedDB` because storage APIs
 * are absent in sandboxed and private-browsing contexts, where detection should still work.
 *
 * Values are compared against `undefined` rather than tested with `in` so that a server-side shim
 * which declares `window` without assigning it is still treated as a non-browser scope.
 *
 * @param scope - Global scope to inspect. Defaults to the ambient one; injectable for testing.
 * @internal
 */
export function isBrowserEnvironment(scope: GlobalScopeLike = globalThis): boolean {
  if (scope.window !== undefined) {
    return true;
  }

  return scope.WorkerGlobalScope !== undefined && scope.WorkerNavigator !== undefined;
}
