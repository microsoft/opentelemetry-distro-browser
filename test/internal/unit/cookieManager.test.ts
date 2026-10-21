// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { afterEach, expect, it, vi } from "vitest";
import { createCookieManager } from "../../../src/storage/cookieManager.js";
import type { MicrosoftOpenTelemetryBrowserCookieConfig } from "../../../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "otel-cookie-manager-test=; max-age=0; path=/";
});

it("reads, writes, and deletes actual browser cookies without touching web storage", () => {
  const local = vi.spyOn(window, "localStorage", "get");
  const session = vi.spyOn(window, "sessionStorage", "get");
  const manager = createCookieManager();
  expect(manager.isEnabled()).toBe(true);
  expect(manager.set("otel-cookie-manager-test", "a=b%20c", 60)).toBe(true);
  expect(manager.get("otel-cookie-manager-test")).toBe("a=b%20c");
  expect(manager.get("otel-cookie-manager-tes")).toBe("");
  expect(manager.del("otel-cookie-manager-test")).toBe(true);
  expect(manager.get("otel-cookie-manager-test")).toBe("");
  expect(local).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
});

it("formats session and persistent cookies and deletes the configured domain/path", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const manager = createCookieManager({
    domain: ".example.test",
    path: "/app",
    setCookie,
    delCookie,
  });
  vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  expect(manager.set("name", " value ", 60)).toBe(true);
  const secure = location.protocol === "https:" ? "; secure; SameSite=None" : "";
  expect(setCookie).toHaveBeenLastCalledWith(
    "name",
    `value; expires=Thu, 01 Jan 2026 00:01:00 GMT; max-age=60${secure}; domain=.example.test; path=/app`,
  );
  manager.set("name", "session", undefined, "override.test", "/other");
  expect(setCookie).toHaveBeenLastCalledWith(
    "name",
    `session${secure}; domain=override.test; path=/other`,
  );
  manager.del("name");
  expect(delCookie).toHaveBeenLastCalledWith(
    "name",
    `; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0${location.protocol === "https:" ? "; secure" : ""}; domain=.example.test; path=/app`,
  );
  manager.purge("name", "/other");
  expect(delCookie.mock.calls.at(-1)?.[1]).toContain("path=/other");
});

it("uses the configured path for actual host-only cookie deletion", () => {
  // Domain=localhost is not portable across browser engines. Explicit domain formatting and
  // matching deletion scope are covered by the hook-based test above.
  const manager = createCookieManager({ path: "/" });
  manager.set("otel-cookie-manager-test", "identity");
  expect(manager.get("otel-cookie-manager-test")).toBe("identity");
  expect(manager.purge("otel-cookie-manager-test")).toBe(true);
  expect(manager.get("otel-cookie-manager-test")).toBe("");
});

it("avoids cookie support probes when disabled without any hooks", () => {
  const read = vi.spyOn(document, "cookie", "get");
  const write = vi.spyOn(document, "cookie", "set");
  const manager = createCookieManager({ enabled: false });
  expect(manager.isEnabled()).toBe(false);
  expect(manager.set("name", "value")).toBe(true);
  expect(manager.get("name")).toBe("value");
  expect(manager.del("name")).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it("flushes explicit deletes for ignored and blocked cookies", () => {
  const delCookie = vi.fn();
  const manager = createCookieManager({
    enabled: false,
    ignoreCookies: ["ignored"],
    blockedCookies: ["blocked"],
    delCookie,
  });
  expect(manager.del("ignored")).toBe(true);
  expect(manager.del("blocked")).toBe(true);
  manager.setEnabled(true);
  expect(delCookie.mock.calls.map(([name]) => name)).toEqual(["ignored", "blocked"]);
});

it("does not access cookies while disabled and flushes only the latest operation per name", () => {
  const read = vi.spyOn(document, "cookie", "get");
  const write = vi.spyOn(document, "cookie", "set");
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const manager = createCookieManager({ enabled: false, setCookie, delCookie });
  expect(manager.isEnabled()).toBe(false);
  expect(manager.get("old")).toBe("");
  expect(manager.set("name", "first")).toBe(true);
  expect(manager.set("name", "second")).toBe(true);
  expect(manager.get("name")).toBe("second");
  expect(manager.del("name")).toBe(true);
  expect(manager.get("name")).toBe("");
  manager.del("other");
  manager.set("other", "latest");
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(setCookie).not.toHaveBeenCalled();
  expect(delCookie).not.toHaveBeenCalled();
  manager.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(1);
  expect(setCookie.mock.calls[0]?.[0]).toBe("other");
  expect(delCookie).toHaveBeenCalledTimes(1);
  manager.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(1);
});

it("formats expiry at enqueue rather than extending it on enable", () => {
  const setCookie = vi.fn();
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
  const manager = createCookieManager({ enabled: false, setCookie });
  manager.set("name", "value", 60);
  now.mockReturnValue(Date.UTC(2026, 0, 2));
  manager.setEnabled(true);
  expect(setCookie.mock.calls[0]?.[1]).toContain("expires=Thu, 01 Jan 2026 00:01:00 GMT");
});

it("can disable deferral completely", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const manager = createCookieManager({
    enabled: false,
    disableCookieDefer: true,
    setCookie,
    delCookie,
  });
  expect(manager.set("name", "value")).toBe(false);
  expect(manager.del("name")).toBe(false);
  expect(manager.get("name")).toBe("");
  manager.setEnabled(true);
  expect(setCookie).not.toHaveBeenCalled();
  expect(delCookie).not.toHaveBeenCalled();
});

it("purges immediately while disabled and cancels pending writes even when deletion fails", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn(() => {
    throw new Error("denied");
  });
  const manager = createCookieManager({ enabled: false, setCookie, delCookie });
  manager.set("name", "identity");
  expect(manager.purge("name")).toBe(false);
  expect(manager.get("name")).toBe("");
  manager.setEnabled(true);
  expect(setCookie).not.toHaveBeenCalled();
});

it("snapshots ignored/blocked lists, allows blocked reads and permits explicit cleanup", () => {
  const ignoreCookies = ["ignored"];
  const blockedCookies = ["blocked"];
  const getCookie = vi.fn(() => "stored");
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const config = {
    ignoreCookies,
    blockedCookies,
    getCookie,
    setCookie,
    delCookie,
    path: "/original",
  };
  const manager = createCookieManager(config);
  ignoreCookies.length = 0;
  blockedCookies.length = 0;
  config.path = "/mutated";
  expect(manager.get("ignored")).toBe("");
  expect(getCookie).not.toHaveBeenCalled();
  expect(manager.get("blocked")).toBe("stored");
  expect(manager.set("ignored", "value")).toBe(false);
  expect(manager.set("blocked", "value")).toBe(false);
  manager.del("ignored");
  manager.purge("blocked");
  expect(delCookie).toHaveBeenCalledTimes(2);
  manager.set("allowed", "value");
  expect(setCookie.mock.calls[0]?.[1]).toContain("path=/original");
});

it.each([null, [], false, 1, "cookies", () => {}])(
  "rejects malformed config %j before cookie access",
  (config) => {
    const read = vi.spyOn(document, "cookie", "get");
    const write = vi.spyOn(document, "cookie", "set");
    expect(() => createCookieManager(config as MicrosoftOpenTelemetryBrowserCookieConfig)).toThrow(
      TypeError,
    );
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  },
);

it.each([
  { enabled: "false" },
  { domain: 1 },
  { path: false },
  { disableCookieDefer: 0 },
  { ignoreCookies: "name" },
  { ignoreCookies: [1] },
  { blockedCookies: [null] },
  { blockedCookies: new Array(1) },
  { getCookie: true },
  { setCookie: 1 },
  { delCookie: {} },
  { domain: "example.test; secure" },
  { path: "/\r\ninjected" },
])("rejects malformed member %j before cookie access", (config) => {
  const read = vi.spyOn(document, "cookie", "get");
  const write = vi.spyOn(document, "cookie", "set");
  expect(() => createCookieManager(config as MicrosoftOpenTelemetryBrowserCookieConfig)).toThrow(
    TypeError,
  );
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it.each(["inherited", "non-enumerable"])("snapshots %s settings once", (kind) => {
  const enabled = vi.fn(() => false);
  const fields = { enabled: { get: enabled }, path: { value: "/scoped" } };
  const source = Object.defineProperties({}, fields);
  const config = kind === "inherited" ? Object.create(source) : source;
  const manager = createCookieManager(config);
  expect(manager.isEnabled()).toBe(false);
  expect(manager.set("name", "value")).toBe(true);
  expect(manager.get("name")).toBe("value");
  expect(enabled).toHaveBeenCalledTimes(1);
});

it.each(["bad;name", "bad=name", "bad name", "bad\r\nname", ""])(
  "rejects unsafe names %j",
  (name) => {
    const setCookie = vi.fn();
    const manager = createCookieManager({ setCookie });
    expect(manager.set(name, "value")).toBe(false);
    expect(manager.get(name)).toBe("");
    expect(manager.del(name)).toBe(false);
    expect(manager.purge(name)).toBe(false);
    expect(setCookie).not.toHaveBeenCalled();
  },
);

it("rejects value/attribute injection and invalid lifetimes without calling hooks", () => {
  const setCookie = vi.fn();
  const manager = createCookieManager({ setCookie });
  for (const value of ["value; secure", "value\n", "value\x00", "value\x7f"]) {
    expect(manager.set("name", value)).toBe(false);
  }
  expect(manager.set("name", "value", 60, "host; injected")).toBe(false);
  expect(manager.set("name", "value", 60, undefined, "/; injected")).toBe(false);
  for (const age of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) {
    expect(manager.set("name", "value", age)).toBe(false);
  }
  expect(setCookie).not.toHaveBeenCalled();
});

it("contains document and hook failures with diagnostics", () => {
  const warn = vi.spyOn(diag, "warn");
  const read = vi.spyOn(document, "cookie", "get").mockImplementation(() => {
    throw new Error("denied");
  });
  vi.spyOn(document, "cookie", "set").mockImplementation(() => {
    throw new Error("denied");
  });
  const manager = createCookieManager();
  expect(manager.isEnabled()).toBe(false);
  expect(manager.get("name")).toBe("");
  expect(manager.set("name", "value")).toBe(false);
  expect(manager.del("name")).toBe(false);
  expect(manager.purge("name")).toBe(false);
  expect(read).toHaveBeenCalled();
  expect(warn).toHaveBeenCalled();
  const fail = () => {
    throw new Error("hook failure");
  };
  const hooked = createCookieManager({ getCookie: fail, setCookie: fail, delCookie: fail });
  expect(hooked.get("name")).toBe("");
  expect(hooked.set("name", "value")).toBe(false);
  expect(hooked.del("name")).toBe(false);
  expect(hooked.purge("name")).toBe(false);
  warn.mockImplementation(fail);
  expect(hooked.get("name")).toBe("");
});

it("isolates state and shuts down permanently while retaining explicit purge", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const first = createCookieManager({ enabled: false, setCookie, delCookie });
  const second = createCookieManager({ enabled: false, setCookie, delCookie });
  first.set("name", "first");
  second.set("name", "second");
  first.shutdown();
  first.shutdown();
  first.setEnabled(true);
  expect(first.isEnabled()).toBe(false);
  expect(first.get("name")).toBe("");
  expect(first.set("name", "later")).toBe(false);
  expect(first.del("name")).toBe(false);
  expect(first.purge("name")).toBe(true);
  expect(delCookie).toHaveBeenCalledTimes(1);
  expect(second.get("name")).toBe("second");
  second.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(1);
  expect(setCookie.mock.calls[0]?.[1]).toMatch(/^second;/);
});

it.each(["__Host-identity", "__Secure-identity"])(
  "formats %s cleanup for the current protocol, including after shutdown",
  (name) => {
    const setCookie = vi.fn();
    const delCookie = vi.fn();
    const manager = createCookieManager({ setCookie, delCookie });
    const secure = location.protocol === "https:" ? "; secure" : "";
    expect(manager.set(name, "identity")).toBe(true);
    expect(setCookie).toHaveBeenCalledWith(
      name,
      `identity${secure ? `${secure}; SameSite=None` : ""}; path=/`,
    );
    expect(manager.del(name)).toBe(true);
    expect(manager.purge(name)).toBe(true);
    manager.shutdown();
    expect(manager.del(name)).toBe(true);
    expect(delCookie).toHaveBeenCalledTimes(3);
    for (const [deletedName, value] of delCookie.mock.calls) {
      expect(deletedName).toBe(name);
      expect(value).toBe(`; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0${secure}; path=/`);
    }
  },
);

it.each([{ domain: "example.test" }, { path: "/app" }])(
  "rejects invalid Host cookie scope %j without restricting reads",
  (scope) => {
    const setCookie = vi.fn();
    const delCookie = vi.fn();
    const manager = createCookieManager({
      ...scope,
      getCookie: () => "identity",
      setCookie,
      delCookie,
    });
    expect(manager.get("__Host-identity")).toBe("identity");
    expect(manager.set("__Host-identity", "identity")).toBe(false);
    expect(manager.del("__Host-identity")).toBe(false);
    expect(manager.purge("__Host-identity")).toBe(false);
    expect(setCookie).not.toHaveBeenCalled();
    expect(delCookie).not.toHaveBeenCalled();
  },
);

it("validates effective Host cookie overrides before writing or purging", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const manager = createCookieManager({ path: "/app", setCookie, delCookie });
  expect(manager.set("__Host-identity", "identity", undefined, undefined, "/")).toBe(true);
  expect(manager.purge("__Host-identity", "/")).toBe(true);
  expect(manager.set("__Host-identity", "identity", undefined, "example.test", "/")).toBe(false);
  expect(manager.purge("__Host-identity", "/other")).toBe(false);
  expect(setCookie).toHaveBeenCalledTimes(1);
  expect(delCookie).toHaveBeenCalledTimes(1);
});

it("contains post-shutdown deletion failures and never resumes deferred writes", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn(() => {
    throw new Error("denied");
  });
  const manager = createCookieManager({
    enabled: false,
    disableCookieDefer: true,
    setCookie,
    delCookie,
  });
  expect(manager.del("name")).toBe(false);
  expect(delCookie).not.toHaveBeenCalled();
  manager.setEnabled(true);
  manager.shutdown();
  expect(manager.del("name")).toBe(false);
  expect(delCookie).toHaveBeenCalledTimes(1);
  manager.setEnabled(true);
  expect(manager.set("name", "identity")).toBe(false);
  expect(setCookie).not.toHaveBeenCalled();
});
