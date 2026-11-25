// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { afterEach, expect, it, vi } from "vitest";
import { createCookieManager } from "../../../src/storage/cookieManager.js";
import type { MicrosoftOpenTelemetryBrowserCookieConfig } from "../../../src/types.js";
import { createCookieUserContext } from "../../../src/user/createCookieUserContext.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.cookie = "otel-cookie-manager-test=; max-age=0; path=/";
});

it("keeps internal failed-read status distinct from successful missing and ignored cookies", () => {
  const getCookie = vi.fn((_name: string): string => {
    throw new Error("cookie access failed");
  });
  const manager = createCookieManager({ getCookie, ignoreCookies: ["ignored"] });
  expect(manager.get("name")).toBe("");
  expect(manager.read("name")).toEqual({ success: false });
  expect(manager.read("ignored")).toEqual({ success: true, value: "" });
  expect(getCookie).toHaveBeenCalledTimes(2);
  getCookie.mockReturnValue("");
  expect(manager.read("name")).toEqual({ success: true, value: "" });
  getCookie.mockReturnValue("existing");
  expect(manager.read("name")).toEqual({ success: true, value: "existing" });
  manager.setEnabled(false);
  manager.set("name", "deferred");
  getCookie.mockClear();
  expect(manager.read("name")).toEqual({ success: true, value: "deferred" });
  expect(getCookie).not.toHaveBeenCalled();
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
    `; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0${secure}; domain=.example.test; path=/app`,
  );
  manager.purge("name", "/other");
  expect(delCookie).toHaveBeenLastCalledWith(
    "name",
    `; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0${secure}; domain=.example.test; path=/other`,
  );
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

it.each([false, true])(
  "rejects oversized UTF-8 cookies before writing or deferring (enabled=%s)",
  (enabled) => {
    const setCookie = vi.fn();
    const manager = createCookieManager({ enabled, setCookie });
    expect(manager.set("name", "a".repeat(4083))).toBe(true);
    expect(manager.set("name", "a".repeat(4084))).toBe(false);
    expect(manager.set("other", "雪".repeat(1400))).toBe(false);
    expect(
      manager.set("large-attributes", "a".repeat(4050), undefined, "example.test", "/long-path"),
    ).toBe(false);
    manager.setEnabled(true);
    expect(setCookie).toHaveBeenCalledOnce();
    expect(setCookie.mock.calls[0]?.[0]).toBe("name");
  },
);

it("preserves a newer nested write when a cancelled replay writes afterward", () => {
  const values = new Map<string, string>();
  const manager = createCookieManager({
    enabled: false,
    getCookie: (name) => values.get(name) ?? "",
    setCookie(name, formatted) {
      const value = formatted.split(";")[0]!;
      if (value === "old") {
        manager.cancelPending(name, value);
        manager.set(name, "newer");
      }
      values.set(name, value);
    },
    delCookie: (name) => values.delete(name),
  });
  manager.set("ai_session", "old");
  manager.setEnabled(true);
  expect(values.get("ai_session")).toBe("newer");
});

it.each(
  ["purge", "del", "set", "set-fails"].flatMap((action) =>
    [false, true].map((retry) => ({ action, retry })),
  ),
)(
  "coordinates nested $action during a corrective cookie write (retry=$retry)",
  ({ action, retry }) => {
    const values = new Map<string, string>();
    const writes: string[] = [];
    let readsFail = retry;
    const cookies = createCookieManager({
      enabled: false,
      getCookie(name) {
        if (readsFail) throw new Error("read denied");
        return values.get(name) ?? "";
      },
      setCookie(name, formatted) {
        const value = formatted.split(";")[0]!;
        writes.push(value);
        if (value === "latest" && action === "set-fails") throw new Error("write denied");
        if (writes.length === 1) {
          cookies.cancelPending(name, value);
          expect(cookies.set(name, "replacement")).toBe(true);
        } else if (writes.length === 3) {
          if (action === "purge") expect(cookies.purge(name)).toBe(true);
          else if (action === "del") expect(cookies.del(name)).toBe(true);
          else expect(cookies.set(name, "latest")).toBe(action !== "set-fails");
        }
        // Even the corrective hook can finish after its nested operation.
        values.set(name, value);
      },
      delCookie: (name) => values.delete(name),
    });
    cookies.set("ai_session", "old");
    cookies.setEnabled(true);
    if (retry) {
      expect(values.get("ai_session")).toBe("old");
      readsFail = false;
      cookies.setEnabled(true);
    }
    const expected =
      action === "set-fails" ? "replacement" : action === "set" ? "latest" : undefined;
    expect(values.get("ai_session")).toBe(expected);
    const completedWrites = [...writes];
    cookies.setEnabled(true);
    expect(writes).toEqual(completedWrites);
    expect(values.get("ai_session")).toBe(expected);
    cookies.shutdown();
  },
);

it("coordinates a newer write inside a corrective deletion hook", () => {
  const values = new Map<string, string>();
  const delCookie = vi.fn((name: string) => {
    expect(cookies.set(name, "latest")).toBe(true);
    values.delete(name);
  });
  const cookies = createCookieManager({
    enabled: false,
    getCookie: (name) => values.get(name) ?? "",
    setCookie(name, formatted) {
      const value = formatted.split(";")[0]!;
      if (value === "old") cookies.cancelPending(name, value);
      values.set(name, value);
    },
    delCookie,
  });
  cookies.set("ai_session", "old");
  cookies.setEnabled(true);
  expect(values.get("ai_session")).toBe("latest");
  expect(delCookie).toHaveBeenCalledOnce();
  cookies.setEnabled(true);
  expect(values.get("ai_session")).toBe("latest");
  expect(delCookie).toHaveBeenCalledOnce();
  cookies.shutdown();
});

it.each(["disable", "shutdown", "disable-enable-disable"] as const)(
  "does not resume corrective cookie writes after %s inside the hook",
  (action) => {
    const values = new Map<string, string>();
    const writes: string[] = [];
    const cookies = createCookieManager({
      enabled: false,
      getCookie: (name) => values.get(name) ?? "",
      setCookie(name, formatted) {
        const value = formatted.split(";")[0]!;
        writes.push(value);
        if (writes.length === 1) {
          cookies.cancelPending(name, value);
          cookies.set(name, "replacement");
        } else if (writes.length === 3) {
          cookies.set(name, "latest");
          if (action === "shutdown") cookies.shutdown();
          else {
            cookies.setEnabled(false);
            if (action === "disable-enable-disable") {
              cookies.setEnabled(true);
              cookies.setEnabled(false);
            }
          }
        }
        values.set(name, value);
      },
      delCookie: (name) => values.delete(name),
    });
    cookies.set("ai_session", "old");
    cookies.setEnabled(true);
    expect(cookies.isAccessEnabled()).toBe(false);
    expect(writes).toEqual(["old", "replacement", "replacement", "latest"]);
    expect(values.get("ai_session")).toBe("replacement");
    cookies.setEnabled(true);
    expect(values.get("ai_session")).toBe(action === "shutdown" ? "replacement" : "latest");
    cookies.shutdown();
  },
);

it("retries a failed purge inside a corrective hook at the corrected cookie's scope", () => {
  const values = new Map<string, string>();
  const writes: string[] = [];
  const key = (name: string, formatted: string) =>
    `${name}:${formatted.match(/; path=([^;]+)/)![1]}`;
  const delCookie = vi.fn((name: string, formatted: string) => {
    if (delCookie.mock.calls.length <= 3) throw new Error("delete denied");
    values.delete(key(name, formatted));
  });
  const cookies = createCookieManager({
    enabled: false,
    path: "/default",
    getCookie: (name) => values.get(`${name}:/override`) ?? "",
    setCookie(name, formatted) {
      const value = formatted.split(";")[0]!;
      writes.push(value);
      if (writes.length === 1) {
        cookies.cancelPending(name, value);
        cookies.set(name, "replacement", undefined, undefined, "/override");
      } else if (writes.length === 3) {
        expect(cookies.purge(name, "/other")).toBe(false);
      }
      values.set(key(name, formatted), value);
    },
    delCookie,
  });
  cookies.set("ai_session", "old", undefined, undefined, "/override");
  cookies.setEnabled(true);
  expect(values.get("ai_session:/override")).toBe("replacement");
  expect(delCookie).toHaveBeenCalledTimes(3);
  cookies.setEnabled(true);
  expect(values.size).toBe(0);
  expect(delCookie).toHaveBeenLastCalledWith(
    "ai_session",
    expect.stringMatching(/; path=\/override$/),
  );
  cookies.setEnabled(true);
  expect(delCookie).toHaveBeenCalledTimes(4);
  expect(writes).toEqual(["old", "replacement", "replacement"]);
  cookies.shutdown();
});

it("bounds corrective re-entry and retains the latest recovery for a later retry", () => {
  const values = new Map<string, string>();
  const writes: string[] = [];
  let nested = false;
  let reenter = true;
  let sequence = 0;
  const cookies = createCookieManager({
    enabled: false,
    getCookie: (name) => values.get(name) ?? "",
    setCookie(name, formatted) {
      const value = formatted.split(";")[0]!;
      writes.push(value);
      if (writes.length === 1) {
        cookies.cancelPending(name, value);
        nested = true;
        cookies.set(name, "correction-0");
        nested = false;
      } else if (reenter && !nested) {
        nested = true;
        expect(cookies.set(name, `correction-${++sequence}`)).toBe(true);
        cookies.setEnabled(true);
        expect(cookies.removeIfValue(name, value)).toBe(false);
        nested = false;
      }
      values.set(name, value);
    },
    delCookie: (name) => values.delete(name),
  });
  cookies.set("ai_session", "old");
  cookies.setEnabled(true);
  expect(writes).toEqual([
    "old",
    "correction-0",
    "correction-0",
    "correction-1",
    "correction-1",
    "correction-2",
  ]);
  expect(values.get("ai_session")).toBe("correction-1");
  reenter = false;
  cookies.setEnabled(true);
  expect(values.get("ai_session")).toBe("correction-2");
  expect(writes).toHaveLength(7);
  cookies.setEnabled(true);
  expect(writes).toHaveLength(7);
  cookies.shutdown();
});

it("does not restore a superseded correction over a newer deferred operation", () => {
  const values = new Map<string, string>();
  const writes: string[] = [];
  const cookies = createCookieManager({
    enabled: false,
    getCookie: (name) => values.get(name) ?? "",
    setCookie(name, formatted) {
      const value = formatted.split(";")[0]!;
      writes.push(value);
      if (writes.length === 1) {
        cookies.cancelPending(name, value);
        cookies.set(name, "replacement");
      } else if (writes.length === 3) {
        cookies.set(name, "accepted");
        cookies.setEnabled(false);
        cookies.set(name, "deferred");
        cookies.setEnabled(true);
      }
      values.set(name, value);
    },
    delCookie: (name) => values.delete(name),
  });
  cookies.set("ai_session", "old");
  cookies.setEnabled(true);
  expect(values.get("ai_session")).toBe("deferred");
  expect(writes).toEqual(["old", "replacement", "replacement", "accepted", "deferred"]);
  cookies.setEnabled(true);
  expect(writes).toHaveLength(5);
  cookies.shutdown();
});

it("queries snapshotted per-name read permission without cookie access", () => {
  const ignored = ["ignored"];
  const manager = createCookieManager({ ignoreCookies: ignored, blockedCookies: ["blocked"] });
  ignored.length = 0;
  const read = vi.spyOn(document, "cookie", "get");
  expect(manager.canRead("ignored")).toBe(false);
  expect(manager.canRead("blocked")).toBe(true);
  expect(read).not.toHaveBeenCalled();
});

it("preserves the outer replay while a different cookie is conditionally cleaned up", () => {
  const values = new Map([["other", "stale"]]);
  const cookies = createCookieManager({
    enabled: false,
    getCookie: (name) => values.get(name) ?? "",
    setCookie(name, formatted) {
      const value = formatted.split(";")[0]!;
      if (name === "ai_session" && value === "old") {
        cookies.cancelPending(name, value);
        expect(cookies.removeIfValue("other", "stale")).toBe(true);
      }
      values.set(name, value);
    },
    delCookie(name) {
      if (name === "other") expect(cookies.set("ai_session", "latest")).toBe(true);
      values.delete(name);
    },
  });
  cookies.set("ai_session", "old");
  cookies.setEnabled(true);
  expect(values.get("ai_session")).toBe("latest");
  expect(values.has("other")).toBe(false);
  cookies.shutdown();
});

it("flushes deferred operations after a corrective hook re-enables cookies", () => {
  const values = new Map([["ai_session", "old"]]);
  const cookies = createCookieManager({
    getCookie: (name) => values.get(name) ?? "",
    setCookie: (name, formatted) => values.set(name, formatted.split(";")[0]!),
    delCookie(name) {
      cookies.setEnabled(false);
      expect(cookies.set("other", "deferred")).toBe(true);
      cookies.setEnabled(true);
      values.delete(name);
    },
  });
  expect(cookies.removeIfValue("ai_session", "old")).toBe(true);
  expect(values.has("ai_session")).toBe(false);
  expect(values.get("other")).toBe("deferred");
  cookies.shutdown();
});

it("honors an already-enabled retry requested from a direct corrective hook", () => {
  const values = new Map([["ai_session", "old"]]);
  let fail = true;
  const cookies = createCookieManager({
    enabled: false,
    getCookie: (name) => values.get(name) ?? "",
    setCookie(name, formatted) {
      if (fail) throw new Error("write denied");
      values.set(name, formatted.split(";")[0]!);
    },
    delCookie(name) {
      fail = false;
      cookies.setEnabled(true);
      values.delete(name);
    },
  });
  cookies.set("other", "deferred");
  cookies.setEnabled(true);
  expect(values.has("other")).toBe(false);
  expect(cookies.removeIfValue("ai_session", "old")).toBe(true);
  expect(values.get("other")).toBe("deferred");
  expect(values.has("ai_session")).toBe(false);
  cookies.shutdown();
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

it("cancels only the matching pending write without touching browser cookies or newer operations", () => {
  const values = new Map([["ai_session", "current"]]);
  const getCookie = vi.fn((name: string) => values.get(name) ?? "");
  const setCookie = vi.fn((name: string, value: string) => {
    values.set(name, value.split(";")[0]!);
  });
  const delCookie = vi.fn((name: string) => values.delete(name));
  const manager = createCookieManager({ enabled: false, getCookie, setCookie, delCookie });
  manager.set("ai_session", "old");
  manager.cancelPending("ai_session", "old");
  expect(manager.get("ai_session")).toBe("");
  manager.set("ai_session", "newer");
  manager.cancelPending("ai_session", "old");
  expect(manager.get("ai_session")).toBe("newer");
  manager.del("other");
  manager.cancelPending("other", "");
  for (const operation of [getCookie, setCookie, delCookie]) {
    expect(operation).not.toHaveBeenCalled();
  }
  expect(values.get("ai_session")).toBe("current");
  manager.setEnabled(true);
  expect(values.get("ai_session")).toBe("newer");
  expect(delCookie).toHaveBeenCalledExactlyOnceWith("other", expect.any(String));
  setCookie.mockClear();
  delCookie.mockClear();
  getCookie.mockClear();
  manager.cancelPending("ai_session", "newer");
  for (const operation of [getCookie, setCookie, delCookie]) {
    expect(operation).not.toHaveBeenCalled();
  }
  expect(values.get("ai_session")).toBe("newer");
});

it("removes an accepted stale value only while it still owns the current cookie", () => {
  const values = new Map([["ai_session", "newer"]]);
  const delCookie = vi.fn((name: string) => values.delete(name));
  let fails = false;
  const manager = createCookieManager({
    getCookie(name) {
      if (fails) throw new Error("unavailable");
      return values.get(name) ?? "";
    },
    delCookie,
  });
  manager.removeIfValue("ai_session", "old");
  expect(values.get("ai_session")).toBe("newer");
  values.set("ai_session", "old");
  fails = true;
  manager.removeIfValue("ai_session", "old");
  expect(delCookie).not.toHaveBeenCalled();
  fails = false;
  manager.removeIfValue("ai_session", "old");
  expect(values.has("ai_session")).toBe(false);
  expect(delCookie).toHaveBeenCalledExactlyOnceWith("ai_session", expect.any(String));
});

it.each(["disable", "shutdown", "disable-enable"] as const)(
  "does not conditionally delete after a read hook changes access with %s",
  (action) => {
    const values = new Map([["ai_session", "old"]]);
    let revoke = true;
    const delCookie = vi.fn((name: string) => values.delete(name));
    const cookies = createCookieManager({
      getCookie(name) {
        if (revoke) {
          if (action === "shutdown") cookies.shutdown();
          else {
            cookies.setEnabled(false);
            if (action === "disable-enable") cookies.setEnabled(true);
          }
        }
        return values.get(name) ?? "";
      },
      delCookie,
    });
    expect(cookies.removeIfValue("ai_session", "old")).toBe(false);
    expect(values.get("ai_session")).toBe("old");
    expect(delCookie).not.toHaveBeenCalled();
    revoke = false;
    cookies.setEnabled(true);
    expect(cookies.removeIfValue("ai_session", "old")).toBe(action !== "shutdown");
    expect(delCookie).toHaveBeenCalledTimes(action === "shutdown" ? 0 : 1);
    cookies.shutdown();
  },
);

it.each(["disable", "shutdown", "disable-enable"] as const)(
  "does not replay a replacement after its conditional read changes access with %s",
  (action) => {
    const values = new Map<string, string>();
    const writes: string[] = [];
    let revoke = true;
    const delCookie = vi.fn((name: string) => values.delete(name));
    const cookies = createCookieManager({
      enabled: false,
      getCookie(name) {
        if (revoke) {
          if (action === "shutdown") cookies.shutdown();
          else {
            cookies.setEnabled(false);
            if (action === "disable-enable") cookies.setEnabled(true);
          }
        }
        return values.get(name) ?? "";
      },
      setCookie(name, formatted) {
        const value = formatted.split(";")[0]!;
        writes.push(value);
        if (value === "old") {
          cookies.cancelPending(name, value);
          cookies.set(name, "newer");
        }
        values.set(name, value);
      },
      delCookie,
    });
    cookies.set("ai_session", "old");
    cookies.setEnabled(true);
    expect(writes).toEqual(["old", "newer"]);
    expect(delCookie).not.toHaveBeenCalled();
    revoke = false;
    cookies.setEnabled(true);
    expect(values.get("ai_session")).toBe(action === "shutdown" ? "old" : "newer");
    cookies.shutdown();
  },
);

it("does not conditionally delete a newer write made by its read hook", () => {
  const values = new Map([["ai_session", "old"]]);
  const delCookie = vi.fn((name: string) => values.delete(name));
  const cookies = createCookieManager({
    getCookie(name) {
      const observed = values.get(name) ?? "";
      cookies.set(name, "newer");
      return observed;
    },
    setCookie: (name, value) => values.set(name, value.split(";")[0]!),
    delCookie,
  });
  expect(cookies.removeIfValue("ai_session", "old")).toBe(false);
  expect(values.get("ai_session")).toBe("newer");
  expect(delCookie).not.toHaveBeenCalled();
  cookies.shutdown();
});

it.each(["set", "defer", "purge"] as const)(
  "does not retry interrupted cleanup after a newer %s supersedes it",
  (action) => {
    const values = new Map<string, string>();
    let revoke = true;
    const cookies = createCookieManager({
      enabled: false,
      getCookie(name) {
        if (revoke) cookies.setEnabled(false);
        return values.get(name) ?? "";
      },
      setCookie(name, formatted) {
        const value = formatted.split(";")[0]!;
        if (value === "old") {
          cookies.cancelPending(name, value);
          cookies.set(name, "replacement");
        }
        values.set(name, value);
      },
      delCookie: (name) => values.delete(name),
    });
    cookies.set("ai_session", "old");
    cookies.setEnabled(true);
    revoke = false;
    if (action === "set") cookies.setEnabled(true);
    if (action === "purge") cookies.purge("ai_session");
    else cookies.set("ai_session", "latest");
    cookies.setEnabled(true);
    expect(values.get("ai_session")).toBe(action === "purge" ? undefined : "latest");
    cookies.shutdown();
  },
);

it.each(
  [undefined, "/purged"].flatMap((path) =>
    [2, 3].map((failedDeletes) => ({ path, failedDeletes })),
  ),
)(
  "supersedes a cancelled replay replacement with purge (path=$path, failed deletes=$failedDeletes)",
  ({ path, failedDeletes }) => {
    const values = new Map<string, string>();
    const writes: string[] = [];
    const delCookie = vi.fn((name: string, _formatted: string) => {
      if (delCookie.mock.calls.length <= failedDeletes) throw new Error("delete denied");
      values.delete(name);
    });
    const cookies = createCookieManager({
      enabled: false,
      domain: "example.test",
      path: "/default",
      getCookie: (name) => values.get(name) ?? "",
      setCookie(name, formatted) {
        const value = formatted.split(";")[0]!;
        writes.push(value);
        if (value === "old") {
          cookies.cancelPending(name, value);
          expect(cookies.set(name, "newer", undefined, undefined, path)).toBe(true);
          expect(cookies.purge(name, path)).toBe(false);
        }
        // The outer hook completes after its nested replacement and failed purge.
        values.set(name, value);
      },
      delCookie,
    });
    cookies.set("ai_session", "old", undefined, undefined, path);
    cookies.setEnabled(true);
    expect(writes).toEqual(["old", "newer"]);
    expect(values.get("ai_session")).toBe(failedDeletes === 3 ? "old" : undefined);
    expect(delCookie).toHaveBeenCalledTimes(3);
    cookies.setEnabled(true);
    expect(values.has("ai_session")).toBe(false);
    expect(delCookie).toHaveBeenCalledTimes(failedDeletes === 3 ? 4 : 3);
    cookies.setEnabled(true);
    expect(delCookie).toHaveBeenCalledTimes(failedDeletes === 3 ? 4 : 3);
    expect(writes).toEqual(["old", "newer"]);
    for (const [name, formatted] of delCookie.mock.calls) {
      expect(name).toBe("ai_session");
      expect(formatted).toContain(`; domain=example.test; path=${path ?? "/default"}`);
    }
    cookies.shutdown();
  },
);

it.each(
  [false, true].flatMap((replacement) =>
    ["/default", "/override"].map((path) => ({ replacement, path })),
  ),
)(
  "preserves cancelled-write cleanup when a purge targets a different path (replacement=$replacement, replay path=$path)",
  ({ replacement, path }) => {
    const values = new Map([["ai_session:/other", "other"]]);
    const writes: string[] = [];
    const cookieKey = (name: string, formatted: string) =>
      `${name}:${formatted.match(/; path=([^;]+)/)![1]}`;
    const cookies = createCookieManager({
      enabled: false,
      path: "/default",
      getCookie: (name) => values.get(`${name}:${path}`) ?? "",
      setCookie(name, formatted) {
        const value = formatted.split(";")[0]!;
        writes.push(value);
        if (value === "old") {
          cookies.cancelPending(name, value);
          if (replacement) {
            expect(cookies.set(name, "newer", undefined, undefined, path)).toBe(true);
          }
          expect(cookies.purge(name, "/other")).toBe(true);
        }
        values.set(cookieKey(name, formatted), value);
      },
      delCookie: (name, formatted) => values.delete(cookieKey(name, formatted)),
    });
    cookies.set("ai_session", "old", undefined, undefined, path);
    cookies.setEnabled(true);
    expect(writes).toEqual(replacement ? ["old", "newer"] : ["old"]);
    expect(values.size).toBe(0);
    cookies.setEnabled(true);
    expect(values.size).toBe(0);
    cookies.shutdown();
  },
);

it("preserves a later accepted write during failed post-replay purge cleanup", () => {
  const values = new Map<string, string>();
  const writes: string[] = [];
  const delCookie = vi.fn((name: string) => {
    if (delCookie.mock.calls.length === 2) expect(cookies.set(name, "old")).toBe(true);
    if (delCookie.mock.calls.length <= 2) throw new Error("delete denied");
    values.delete(name);
  });
  const cookies = createCookieManager({
    enabled: false,
    getCookie: (name) => values.get(name) ?? "",
    setCookie(name, formatted) {
      const value = formatted.split(";")[0]!;
      writes.push(value);
      if (writes.length === 1) {
        cookies.cancelPending(name, value);
        expect(cookies.set(name, "newer")).toBe(true);
        expect(cookies.purge(name)).toBe(false);
      }
      values.set(name, value);
    },
    delCookie,
  });
  cookies.set("ai_session", "old");
  cookies.setEnabled(true);
  expect(values.get("ai_session")).toBe("old");
  expect(writes).toEqual(["old", "newer", "old", "old"]);
  expect(delCookie).toHaveBeenCalledTimes(2);
  cookies.setEnabled(true);
  expect(values.get("ai_session")).toBe("old");
  expect(writes).toEqual(["old", "newer", "old", "old"]);
  cookies.shutdown();
});

it.each([false, true])(
  "only accepts a successful newer write after a cancelled replay purge (write fails=%s)",
  (writeFails) => {
    const values = new Map<string, string>();
    const writes: string[] = [];
    const delCookie = vi.fn((name: string) => {
      if (delCookie.mock.calls.length <= 2) throw new Error("delete denied");
      values.delete(name);
    });
    const cookies = createCookieManager({
      enabled: false,
      getCookie: (name) => values.get(name) ?? "",
      setCookie(name, formatted) {
        const value = formatted.split(";")[0]!;
        writes.push(value);
        if (value === "latest" && writeFails) throw new Error("write denied");
        if (value === "old") {
          cookies.cancelPending(name, value);
          expect(cookies.set(name, "newer")).toBe(true);
          expect(cookies.purge(name)).toBe(false);
          expect(cookies.set(name, "latest")).toBe(!writeFails);
        }
        values.set(name, value);
      },
      delCookie,
    });
    cookies.set("ai_session", "old");
    cookies.setEnabled(true);
    cookies.setEnabled(true);
    expect(values.get("ai_session")).toBe(writeFails ? undefined : "latest");
    expect(writes).toEqual(
      writeFails ? ["old", "newer", "latest"] : ["old", "newer", "latest", "latest"],
    );
    cookies.shutdown();
  },
);

it.each([false, true])(
  "cancels an in-flight old replay without undoing a newer cookie (newer=%s)",
  (newer) => {
    const values = new Map<string, string>();
    const manager = createCookieManager({
      enabled: false,
      getCookie: (name) => values.get(name) ?? "",
      setCookie(name, formatted) {
        const value = formatted.split(";")[0]!;
        if (value === "old") {
          manager.cancelPending(name, value);
          values.set(name, value);
          if (newer) manager.set(name, "newer");
        } else values.set(name, value);
      },
      delCookie: (name) => values.delete(name),
    });
    manager.set("ai_session", "old");
    manager.setEnabled(true);
    expect(values.get("ai_session")).toBe(newer ? "newer" : undefined);
  },
);

it("retains conditional replacement cleanup when a newer explicit write fails", () => {
  const values = new Map<string, string>();
  let readsFail = true;
  const cookies = createCookieManager({
    enabled: false,
    getCookie(name) {
      if (readsFail) throw new Error("unavailable");
      return values.get(name) ?? "";
    },
    setCookie(name, formatted) {
      const value = formatted.split(";")[0]!;
      if (value === "failed") throw new Error("write unavailable");
      if (value === "old") {
        cookies.cancelPending(name, value);
        cookies.set(name, "replacement");
      }
      values.set(name, value);
    },
    delCookie: (name) => values.delete(name),
  });
  cookies.set("ai_session", "old");
  cookies.setEnabled(true);
  expect(values.get("ai_session")).toBe("old");
  expect(cookies.set("ai_session", "failed")).toBe(false);
  readsFail = false;
  cookies.setEnabled(true);
  expect(values.get("ai_session")).toBe("replacement");
  cookies.shutdown();
});

it("retains failed deferred writes and deletes for a later enable without generic cleanup", () => {
  const setCookie = vi.fn((): void => {
    throw new Error("denied");
  });
  const delCookie = vi.fn((): void => {
    throw new Error("denied");
  });
  const manager = createCookieManager({ enabled: false, setCookie, delCookie });
  manager.set("replace", "new", 60);
  manager.del("remove");
  manager.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(1);
  expect(delCookie.mock.calls).toEqual([["remove", expect.any(String)]]);
  manager.setEnabled(false);
  expect(manager.get("replace")).toBe("new");
  const formatted = setCookie.mock.calls[0];
  setCookie.mockImplementation(() => {});
  delCookie.mockImplementation(() => {});
  manager.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(2);
  expect(setCookie.mock.calls[1]).toEqual(formatted);
  expect(delCookie).toHaveBeenCalledTimes(2);
  manager.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(2);
  expect(delCookie).toHaveBeenCalledTimes(2);
});

it("does not restore superseded authentication after a deferred replacement hook throws", () => {
  const name = "ai_authUser";
  const values = new Map<string, string>();
  let fail = false;
  const cookies = createCookieManager({
    getCookie: (key) => values.get(key) ?? "",
    setCookie(key, value) {
      if (fail && key === name) throw new Error("denied");
      values.set(key, value.split(";")[0]!);
    },
    delCookie: (key) => values.delete(key),
  });
  // Mirror the initializer's internal identity policy, not a generic cookie-manager policy.
  cookies.setReplayFailureHandler((key, removeSuperseded) => {
    if (key === name) removeSuperseded();
  });
  const first = createCookieUserContext(true, cookies);
  first.context.setAuthenticatedUserContext("A", "account-A", true);
  cookies.setEnabled(false);
  first.context.setAuthenticatedUserContext("B", "account-B", true);
  fail = true;
  cookies.setEnabled(true);
  expect(first.provider.getAuthenticatedUserId()).toBe("B");
  const restored = createCookieUserContext(true, cookies);
  expect(restored.provider.getAuthenticatedUserId()).toBeUndefined();
  expect(restored.provider.getAccountId()).toBeUndefined();
  fail = false;
  cookies.setEnabled(true);
  const recovered = createCookieUserContext(true, cookies);
  expect(recovered.provider.getAuthenticatedUserId()).toBe("B");
  expect(recovered.provider.getAccountId()).toBe("account-B");
});

it.each([false, true])(
  "keeps a failed replacement retry even when scoped cleanup fails=%s",
  (initialCleanupFails) => {
    const name = "auth";
    let stored = "old";
    let fail = true;
    let cleanupFails = initialCleanupFails;
    const setCookie = vi.fn((_name: string, value: string) => {
      if (fail) throw new Error("write denied");
      stored = value.split(";")[0]!;
    });
    const delCookie = vi.fn(() => {
      if (cleanupFails) throw new Error("delete denied");
      stored = "";
    });
    const manager = createCookieManager({
      enabled: false,
      domain: "default.test",
      path: "/default",
      setCookie,
      delCookie,
    });
    const cleanupResults: boolean[] = [];
    manager.setReplayFailureHandler((_key, removeSuperseded) => {
      cleanupResults.push(removeSuperseded());
    });
    manager.set(name, "new", undefined, "override.test", "/override");
    manager.setEnabled(true);
    expect(stored).toBe(cleanupFails ? "old" : "");
    expect(cleanupResults).toEqual([!cleanupFails]);
    expect(delCookie).toHaveBeenCalledExactlyOnceWith(
      name,
      `; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0${location.protocol === "https:" ? "; secure; SameSite=None" : ""}; domain=override.test; path=/override`,
    );
    if (cleanupFails) {
      cleanupFails = false;
      manager.setEnabled(true);
      expect(stored).toBe("");
      expect(cleanupResults).toEqual([false, true]);
    }
    fail = false;
    manager.setEnabled(true);
    expect(stored).toBe("new");
    expect(setCookie).toHaveBeenCalledTimes(initialCleanupFails ? 3 : 2);
    expect(delCookie).toHaveBeenCalledTimes(initialCleanupFails ? 2 : 1);
  },
);

it("uses the accepted Host cookie scope rather than the default path for failed replay cleanup", () => {
  const delCookie = vi.fn();
  const manager = createCookieManager({
    enabled: false,
    path: "/default",
    setCookie: () => {
      throw new Error("denied");
    },
    delCookie,
  });
  manager.setReplayFailureHandler((_name, removeSuperseded) => removeSuperseded());
  expect(manager.set("__Host-auth", "new", undefined, undefined, "/")).toBe(true);
  manager.setEnabled(true);
  expect(delCookie).toHaveBeenCalledWith("__Host-auth", expect.stringMatching(/; path=\/$/));
});

it("contains failure-handler errors, notifies only failed writes, and retains retries", () => {
  const fail = (): void => {
    throw new Error("denied");
  };
  const setCookie = vi.fn(fail);
  const delCookie = vi.fn(fail);
  const manager = createCookieManager({ enabled: false, setCookie, delCookie });
  const handler = vi.fn(fail);
  manager.setReplayFailureHandler(handler);
  manager.set("replace", "new");
  manager.del("remove");
  expect(() => manager.setEnabled(true)).not.toThrow();
  expect(handler).toHaveBeenCalledExactlyOnceWith("replace", expect.any(Function));
  manager.setReplayFailureHandler(undefined);
  setCookie.mockImplementation(() => {});
  delCookie.mockImplementation(() => {});
  manager.setEnabled(true);
  expect(setCookie).toHaveBeenCalledTimes(2);
  expect(delCookie).toHaveBeenCalledTimes(2);
  expect(handler).toHaveBeenCalledTimes(1);
});

it.each(["set", "del", "purge", "defer", "shutdown"] as const)(
  "does not clean up or resurrect a failed replay superseded by reentrant %s",
  (action) => {
    const delCookie = vi.fn();
    const setCookie = vi.fn((_name: string, value: string) => {
      if (!value.startsWith("old;")) return;
      if (action === "defer") manager.setEnabled(false);
      if (action === "set" || action === "defer") manager.set("name", "new");
      else if (action === "del") manager.del("name");
      else if (action === "purge") manager.purge("name");
      else manager.shutdown();
      throw new Error("old write denied");
    });
    const manager = createCookieManager({ enabled: false, setCookie, delCookie });
    const handler = vi.fn((_name: string, removeSuperseded: () => boolean) => removeSuperseded());
    manager.setReplayFailureHandler(handler);
    manager.set("name", "old");
    manager.setEnabled(true);
    expect(handler).not.toHaveBeenCalled();
    manager.setEnabled(true);
    expect(setCookie.mock.calls.map(([, value]) => value.split(";")[0])).toEqual(
      action === "set" || action === "defer" ? ["old", "new"] : ["old"],
    );
    expect(delCookie).toHaveBeenCalledTimes(action === "purge" ? 2 : action === "del" ? 1 : 0);
  },
);

it.each([
  "none",
  "set",
  "set-fails",
  "del",
  "del-before-write",
  "defer",
  "shutdown",
  "other",
] as const)(
  "honors in-flight replay purge unless superseded by a newer same-name write (%s)",
  (action) => {
    const values = new Map<string, string>();
    const delCookie = vi.fn((name: string, _formatted: string) => values.delete(name));
    const manager = createCookieManager({
      enabled: false,
      domain: "example.test",
      path: "/scoped",
      getCookie: (name) => values.get(name) ?? "",
      setCookie(name, value) {
        if (!value.startsWith("old;")) {
          if (action === "set-fails") throw new Error("new write denied");
          values.set(name, value.split(";")[0]!);
          return;
        }
        manager.purge(name);
        if (action === "del-before-write") manager.del(name);
        values.set(name, "old");
        if (action === "defer") manager.setEnabled(false);
        if (action === "set" || action === "set-fails" || action === "defer") {
          manager.set(name, "new");
        } else if (action === "del") manager.del(name);
        else if (action === "shutdown") manager.shutdown();
        else if (action === "other") manager.set("other", "new");
      },
      delCookie,
    });
    manager.set("name", "old");
    manager.setEnabled(true);
    manager.setEnabled(true);
    expect(values.get("name")).toBe(action === "set" || action === "defer" ? "new" : undefined);
    expect(delCookie).toHaveBeenCalledTimes(
      action === "set" || action === "defer"
        ? 1
        : action === "del" || action === "del-before-write"
          ? 3
          : 2,
    );
    for (const [name, formatted] of delCookie.mock.calls) {
      expect(name).toBe("name");
      expect(formatted).toContain("; domain=example.test; path=/scoped");
    }
    manager.shutdown();
  },
);

it.each(["set", "del", "purge", "shutdown"] as const)(
  "invalidates scoped cleanup when a failure handler performs a newer %s",
  (action) => {
    const delCookie = vi.fn();
    const setCookie = vi.fn((_name: string, value: string) => {
      if (value.startsWith("old;")) throw new Error("denied");
    });
    const manager = createCookieManager({ enabled: false, setCookie, delCookie });
    const cleanupResults: boolean[] = [];
    manager.setReplayFailureHandler((_name, removeSuperseded) => {
      if (action === "set") manager.set("name", "new");
      else if (action === "del") manager.del("name");
      else if (action === "purge") manager.purge("name");
      else manager.shutdown();
      cleanupResults.push(removeSuperseded());
    });
    manager.set("name", "old");
    manager.setEnabled(true);
    manager.setEnabled(true);
    expect(cleanupResults).toEqual([false]);
    expect(setCookie).toHaveBeenCalledTimes(action === "set" ? 2 : 1);
    expect(delCookie).toHaveBeenCalledTimes(action === "del" || action === "purge" ? 1 : 0);
  },
);

it("does not resurrect a replacement when its failed cleanup writes a newer value", () => {
  const setCookie = vi.fn((_name: string, value: string) => {
    if (value.startsWith("old;")) throw new Error("write denied");
  });
  const manager = createCookieManager({
    enabled: false,
    setCookie,
    delCookie: () => {
      manager.set("name", "new");
      throw new Error("delete denied");
    },
  });
  const cleanupResults: boolean[] = [];
  manager.setReplayFailureHandler((_name, removeSuperseded) => {
    cleanupResults.push(removeSuperseded());
  });
  manager.set("name", "old");
  manager.setEnabled(true);
  manager.setEnabled(true);
  expect(cleanupResults).toEqual([false]);
  expect(setCookie.mock.calls.map(([, value]) => value.split(";")[0])).toEqual(["old", "new"]);
});

it("bounds nested enables and retains unattempted operations after a hook disables replay", () => {
  let fail = true;
  const setCookie = vi.fn((name: string) => {
    manager.setEnabled(true);
    if (fail && name === "first") {
      manager.setEnabled(false);
      throw new Error("denied");
    }
  });
  const manager = createCookieManager({ enabled: false, setCookie });
  manager.set("first", "one");
  manager.set("second", "two");
  manager.setEnabled(true);
  expect(setCookie.mock.calls.map(([name]) => name)).toEqual(["first"]);
  expect(manager.get("first")).toBe("one");
  expect(manager.get("second")).toBe("two");
  fail = false;
  manager.setEnabled(true);
  expect(setCookie.mock.calls.map(([name]) => name)).toEqual(["first", "first", "second"]);
});

it("skips a snapshot operation replaced by another replay hook", () => {
  const setCookie = vi.fn((name: string, _value: string) => {
    if (name === "first") {
      manager.setEnabled(false);
      manager.set("second", "new");
      manager.setEnabled(true);
    }
  });
  const manager = createCookieManager({ enabled: false, setCookie });
  manager.set("first", "one");
  manager.set("second", "old");
  manager.setEnabled(true);
  expect(setCookie.mock.calls.map(([name]) => name)).toEqual(["first"]);
  manager.setEnabled(true);
  expect(setCookie.mock.calls.map(([name]) => name)).toEqual(["first", "second"]);
  expect(setCookie.mock.calls[1]?.[1]).toMatch(/^new;/);
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
    const secure = location.protocol === "https:" ? "; secure; SameSite=None" : "";
    expect(manager.set(name, "identity")).toBe(true);
    expect(setCookie).toHaveBeenCalledWith(name, `identity${secure}; path=/`);
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
