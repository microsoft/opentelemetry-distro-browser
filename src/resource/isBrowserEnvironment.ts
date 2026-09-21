// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * The subset of a global scope needed to tell a browser scope from a server runtime.
 */
interface GlobalScopeLike {
  readonly window?: unknown;
  readonly WorkerGlobalScope?: unknown;
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
 * place. Checking both keeps web workers supported, which a bare `window` check would exclude.
 *
 * Values are compared against `undefined` rather than tested with `in` so that a server-side shim
 * which declares `window` without assigning it is still treated as a non-browser scope.
 *
 * @param scope - Global scope to inspect. Defaults to the ambient one; injectable for testing.
 * @internal
 */
export function isBrowserEnvironment(scope: GlobalScopeLike = globalThis): boolean {
  return scope.window !== undefined || scope.WorkerGlobalScope !== undefined;
}
