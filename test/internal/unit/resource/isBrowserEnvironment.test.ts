// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { isBrowserEnvironment } from "../../../../src/resource/isBrowserEnvironment.js";

/**
 * Global scopes the detectors are expected to run in, and the runtimes they must refuse.
 *
 * The server runtimes all expose a `navigator` global, which is why the detectors cannot rely on
 * `navigator` alone: Node reports `navigator.userAgent` of `Node.js/<major>` with the server's
 * `language` and `platform`.
 */
const SCOPES: readonly { name: string; scope: object; browser: boolean }[] = [
  { name: "a document context", scope: { window: {}, document: {} }, browser: true },
  {
    name: "a dedicated worker",
    scope: { WorkerGlobalScope: class {}, WorkerNavigator: class {}, self: {}, indexedDB: {} },
    browser: true,
  },
  {
    name: "a service worker",
    scope: { WorkerGlobalScope: class {}, WorkerNavigator: class {}, clients: {}, caches: {} },
    browser: true,
  },
  { name: "jsdom", scope: { window: {}, document: {}, navigator: {} }, browser: true },
  { name: "Node", scope: { navigator: { userAgent: "Node.js/24" }, process: {} }, browser: false },
  {
    name: "Deno",
    scope: { Deno: {}, navigator: { userAgent: "Deno/2.1.4" }, caches: {} },
    browser: false,
  },
  { name: "Bun", scope: { Bun: {}, navigator: { userAgent: "Bun/1.1.38" } }, browser: false },
  {
    // workerd registers WorkerGlobalScope as a global and reports a `Cloudflare-Workers` user
    // agent with a language of `en`, so the worker check must require more than that one global.
    name: "Cloudflare Workers",
    scope: {
      WorkerGlobalScope: class {},
      Navigator: class {},
      navigator: { userAgent: "Cloudflare-Workers", language: "en", platform: "" },
      caches: {},
      self: {},
    },
    browser: false,
  },
  {
    name: "a Vercel edge function",
    scope: { self: {}, fetch: () => undefined },
    browser: false,
  },
  { name: "a bare global scope", scope: {}, browser: false },
  { name: "a shim declaring window as undefined", scope: { window: undefined }, browser: false },
  {
    name: "a worker-like scope without WorkerNavigator",
    scope: { WorkerGlobalScope: class {} },
    browser: false,
  },
];

describe("isBrowserEnvironment", () => {
  for (const { name, scope, browser } of SCOPES) {
    it(`${browser ? "accepts" : "refuses"} ${name}`, () => {
      expect(isBrowserEnvironment(scope)).toBe(browser);
    });
  }

  it("accepts the scope the tests themselves run in", () => {
    expect(isBrowserEnvironment()).toBe(true);
  });
});
