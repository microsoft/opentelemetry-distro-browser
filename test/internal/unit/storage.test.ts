// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { ReadWriteLogRecord } from "@opentelemetry/sdk-logs";
import type { Span } from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  useMicrosoftOpenTelemetry,
  type MicrosoftOpenTelemetryBrowser,
  type MicrosoftOpenTelemetryBrowserOptions,
} from "../../../src/index.js";
import { getSdkLoaderScript } from "../../../src/snippet.js";
import { TEST_INSTRUMENTATION_KEY } from "../../fixtures/azureMonitor.js";

const AZURE_MONITOR_CONNECTION_STRING = `InstrumentationKey=${TEST_INSTRUMENTATION_KEY};IngestionEndpoint=https://example.test`;

const handles: MicrosoftOpenTelemetryBrowser[] = [];
const keys = ["opentelemetry-session", "opentelemetry-user"];
const saved = new Map<string, string | null>();

function clearCookies() {
  for (const prefix of ["", "app-a-", "app-b-", "shop-"]) {
    for (const key of [...keys, "opentelemetry-auth-user"]) {
      document.cookie = `${prefix}${key}=; max-age=0; path=/`;
    }
  }
}

function readCookie(name: string) {
  const value = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
  return value ? JSON.parse(decodeURIComponent(value.slice(name.length + 1))) : null;
}

beforeEach(clearCookies);

function preserve(key: string, value: string | null = null) {
  if (!saved.has(key)) saved.set(key, localStorage.getItem(key));
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.shutdown()));
  trace.disable();
  logs.disable();
  propagation.disable();
  context.disable();
  diag.disable();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearCookies();
  for (const [key, value] of saved) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
  saved.clear();
});

async function initialize(options: MicrosoftOpenTelemetryBrowserOptions = {}) {
  const spans: Span[] = [];
  const records: ReadWriteLogRecord[] = [];
  const handle = await useMicrosoftOpenTelemetry({
    ...options,
    pageView: { enabled: false },
    spanProcessors: [
      {
        onStart: (span) => {
          spans.push(span);
        },
        onEnd() {},
        async forceFlush() {},
        async shutdown() {},
      },
    ],
    logRecordProcessors: [
      {
        onEmit: (record) => {
          records.push(record);
        },
        async forceFlush() {},
        async shutdown() {},
      },
    ],
  });
  handles.push(handle);
  return {
    handle,
    emit() {
      trace.getTracer("storage-test").startSpan("operation").end();
      logs.getLogger("storage-test").emit({});
      const attributes = spans.at(-1)!.attributes;
      expect(records.at(-1)!.attributes).toMatchObject(attributes);
      return attributes;
    },
  };
}

it.each(["string", "promise"] as const)(
  "blocks Web Storage and cookie persistence throughout identity controls, expiry, flush and shutdown (%s)",
  async (destination) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    for (const key of keys) preserve(key, "previous-value");
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const cookie = vi.spyOn(document, "cookie", "get");
    const cookieWrite = vi.spyOn(document, "cookie", "set");
    const fetch = vi.fn(
      async () => new Response("", { status: 503, headers: { "retry-after": "86400" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const { handle, emit } = await initialize({
      storage: { enabled: false },
      azureMonitor: {
        connectionString:
          destination === "string"
            ? AZURE_MONITOR_CONNECTION_STRING
            : Promise.resolve(AZURE_MONITOR_CONNECTION_STRING),
      },
      cookieCfg: { enabled: false, disableCookieDefer: true },
    session: { persist: true, inactivityTimeout: 0.001 },
      userContext: { enabled: true },
    });
    const first = emit()["session.id"];
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    handle.userContext.setEnabled(true);
    handle.userContext.setAuthenticatedUserContext("user", "account");
    expect(emit()["user.id"]).toBe("user");
    expect(emit()["enduser.pseudo.id"]).toBeUndefined();
    handle.userContext.clearAuthenticatedUserContext();
    expect(emit()["user.id"]).toBeUndefined();
    expect(cookieWrite).not.toHaveBeenCalled();
  handle.userContext.setEnabled(false);
    // Explicit identity removal uses purge, which intentionally bypasses disabled cookies.
  expect(cookieWrite.mock.calls).toEqual([
    ["opentelemetry-user=; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0; path=/"],
    ["opentelemetry-auth-user=; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0; path=/"],
  ]);
  cookieWrite.mockClear();
  clock.mockReturnValue(now + 1000);
    expect(emit()["session.id"]).not.toBe(first);
    await handle.forceFlush().catch(() => {});
    expect(fetch).toHaveBeenCalled();
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    await handle.shutdown();
    handle.userContext.setEnabled(true);
    handle.userContext.clearAuthenticatedUserContext();
    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
    expect(cookieWrite).not.toHaveBeenCalled();
    local.mockRestore();
    for (const key of keys) expect(localStorage.getItem(key)).toBe("previous-value");
  },
);

it.each(["string", "promise"] as const)(
  "prefixes unsent telemetry buffer keys (%s)",
  async (destination) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503, headers: { "retry-after": "86400" } })),
    );
    const { handle, emit } = await initialize({
      storage: { namePrefix: "shop-" },
      azureMonitor: {
        connectionString:
          destination === "string"
            ? AZURE_MONITOR_CONNECTION_STRING
            : Promise.resolve(AZURE_MONITOR_CONNECTION_STRING),
      },
    });
    emit();
    await handle.forceFlush().catch(() => {});
    const bufferKeys = Array.from({ length: sessionStorage.length }, (_, index) =>
      sessionStorage.key(index),
    ).filter((key) => key?.includes("opentelemetry-buffer|"));
    expect(bufferKeys.length).toBeGreaterThan(0);
    for (const key of bufferKeys) expect(key).toMatch(/^shop-opentelemetry-buffer\|/);
  },
);

it("isolates prefixed sessions and users, restores them, and scopes identity removal", async () => {
  for (const prefix of ["", "app-a-", "app-b-"]) {
    for (const key of keys) preserve(prefix + key);
  }
  const first = await initialize({ storage: { namePrefix: "app-a-" } });
  first.handle.userContext.setAuthenticatedUserContext("user-a", undefined, true);
  const a = first.emit();
  await first.handle.shutdown();
  const second = await initialize({ storage: { namePrefix: "app-b-" } });
  const b = second.emit();
  expect(b["session.id"]).not.toBe(a["session.id"]);
  expect(b["enduser.pseudo.id"]).not.toBe(a["enduser.pseudo.id"]);
  expect(b["user.id"]).toBeUndefined();
  for (const key of keys) expect(localStorage.getItem(key)).toBeNull();
  await second.handle.shutdown();
  const restored = await initialize({ storage: { namePrefix: "app-a-" } });
  expect(restored.emit()).toMatchObject(a);
  restored.handle.userContext.clearAuthenticatedUserContext();
  expect(readCookie("app-a-opentelemetry-auth-user")).toBeNull();
  expect(readCookie("app-a-opentelemetry-user")).toEqual({
    anonymousId: a["enduser.pseudo.id"],
    acquisitionTimestamp: expect.any(Number),
  });
  restored.handle.userContext.setEnabled(false);
  expect(readCookie("app-a-opentelemetry-user")).toBeNull();
  expect(readCookie("app-b-opentelemetry-user")).toEqual({
    anonymousId: b["enduser.pseudo.id"],
    acquisitionTimestamp: expect.any(Number),
  });
  await restored.handle.shutdown();
  const activeSecond = await initialize({ storage: { namePrefix: "app-b-" } });
  expect(activeSecond.emit()).toMatchObject(b);
  const disabled = await initialize({
    storage: { enabled: false },
    cookieCfg: { enabled: false, disableCookieDefer: true },
  });
  disabled.handle.userContext.setEnabled(true);
  activeSecond.handle.userContext.setAuthenticatedUserContext("user-b", undefined, true);
  expect(readCookie("app-b-opentelemetry-auth-user")).toEqual({
    authenticatedUserId: "user-b",
  });
  expect(readCookie("app-b-opentelemetry-user")).toMatchObject({
    anonymousId: b["enduser.pseudo.id"],
  });
});

it("keeps cookies independent of disabled Web Storage for both signals and restores them", async () => {
  const local = vi.spyOn(window, "localStorage", "get");
  const session = vi.spyOn(window, "sessionStorage", "get");
  const first = await initialize({ storage: { enabled: false } });
  first.handle.userContext.setAuthenticatedUserContext("user-b", "account", true);
  const attributes = first.emit();
  expect(attributes["session.id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(attributes["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(readCookie("opentelemetry-session").id).toBe(attributes["session.id"]);
  expect(readCookie("opentelemetry-auth-user")).toEqual({
    authenticatedUserId: "user-b",
    accountId: "account",
  });
  await first.handle.forceFlush();
  await first.handle.shutdown();
  const restored = await initialize({ storage: { enabled: false } });
  expect(restored.emit()).toMatchObject(attributes);
  await restored.handle.shutdown();
  expect(local).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
});

it.each(["", "app-a-"])(
  "discards the session backup when both identity and session cookies are missing (prefix=%j)",
  async (namePrefix) => {
    const sessionKey = `${namePrefix}opentelemetry-session`;
    preserve(sessionKey);
    const first = await initialize({ storage: { namePrefix } });
    const previous = first.emit();
    await first.handle.shutdown();
    expect(JSON.parse(localStorage.getItem(sessionKey)!).id).toBe(previous["session.id"]);
    clearCookies();
    expect(readCookie(`${namePrefix}opentelemetry-user`)).toBeNull();
    expect(readCookie(sessionKey)).toBeNull();

    const restored = await initialize({ storage: { namePrefix } });
    const current = restored.emit();
    expect(current["session.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(current["session.id"]).not.toBe(previous["session.id"]);
    expect(current["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(current["enduser.pseudo.id"]).not.toBe(previous["enduser.pseudo.id"]);
    expect(localStorage.getItem(sessionKey)).toBeNull();
    expect(readCookie(sessionKey).id).toBe(current["session.id"]);
    await restored.handle.shutdown();
    expect(JSON.parse(localStorage.getItem(sessionKey)!).id).toBe(current["session.id"]);
  },
);

it.each(["trace", "logs"])(
  "rejects an invalid Azure %s destination without browser persistence or cookie hook calls",
  async (signal) => {
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const read = vi.spyOn(document, "cookie", "get");
    const write = vi.spyOn(document, "cookie", "set");
    const getCookie = vi.fn(() => "");
    const setCookie = vi.fn();
    const delCookie = vi.fn();
    await expect(
      useMicrosoftOpenTelemetry({
        azureMonitor: { connectionString: "InstrumentationKey=not-an-instrumentation-key" },
        ...(signal === "logs" ? { spanProcessors: [] } : {}),
        cookieCfg: { getCookie, setCookie, delCookie },
        pageView: { enabled: false },
      }),
    ).rejects.toThrow("valid InstrumentationKey UUID");
    for (const operation of [local, session, read, write, getCookie, setCookie, delCookie]) {
      expect(operation).not.toHaveBeenCalled();
    }
  },
);

it.each(["invalid prefix", "invalid;prefix", "invalid=prefix", "invalid\nprefix", "雪"])(
  "rejects an invalid cookie name prefix before browser persistence or cookie hook calls (%j)",
  async (namePrefix) => {
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const read = vi.spyOn(document, "cookie", "get");
    const write = vi.spyOn(document, "cookie", "set");
    const getCookie = vi.fn(() => "");
    const setCookie = vi.fn();
    const delCookie = vi.fn();
    await expect(
      initialize({ storage: { namePrefix }, cookieCfg: { getCookie, setCookie, delCookie } }),
    ).rejects.toThrow("storage.namePrefix must contain only cookie-name token characters.");
    for (const operation of [local, session, read, write, getCookie, setCookie, delCookie]) {
      expect(operation).not.toHaveBeenCalled();
    }
  },
);

it("disables cookies without touching them and writes only a session Web Storage backup", async () => {
  for (const key of keys) preserve(key);
  const cookie = vi.spyOn(document, "cookie", "get");
  const cookieWrite = vi.spyOn(document, "cookie", "set");
  const write = vi.spyOn(Storage.prototype, "setItem");
  const { handle, emit } = await initialize({
    cookieCfg: { enabled: false, disableCookieDefer: true },
  });
  const attributes = emit();
  expect(attributes["enduser.pseudo.id"]).toBeUndefined();
  handle.userContext.setAuthenticatedUserContext("memory-user", "account", true);
  expect(emit()["user.id"]).toBe("memory-user");
  handle.userContext.clearAuthenticatedUserContext();
  expect(emit()["user.id"]).toBeUndefined();
  await handle.forceFlush();
  expect(write).not.toHaveBeenCalled();
  await handle.shutdown();
  expect(write).toHaveBeenCalledExactlyOnceWith("opentelemetry-session", expect.any(String));
  expect(JSON.parse(localStorage.getItem("opentelemetry-session")!).id).toBe(
    attributes["session.id"],
  );
  expect(localStorage.getItem("opentelemetry-user")).toBeNull();
  expect(cookie).not.toHaveBeenCalled();
  expect(cookieWrite).not.toHaveBeenCalled();
});

it("enables deferred SDK cookies while traces and logs flow immediately", async () => {
  const { handle, emit } = await initialize({
    storage: { enabled: false },
    cookieCfg: { enabled: false },
  });
  handle.userContext.setAuthenticatedUserContext("deferred-user", "account", true);
  const before = emit();
  expect(before["enduser.pseudo.id"]).toMatch(/^[0-9a-f]{32}$/);
  expect(before["user.id"]).toBe("deferred-user");
  expect(document.cookie).toBe("");
  const manager = handle.getCookieMgr();
  expect(manager.isEnabled()).toBe(false);
  manager.setEnabled(true);
  expect(manager.isEnabled()).toBe(true);
  expect(readCookie("opentelemetry-session").id).toBe(before["session.id"]);
  expect(readCookie("opentelemetry-user").anonymousId).toBe(before["enduser.pseudo.id"]);
  expect(readCookie("opentelemetry-auth-user")).toEqual({
    authenticatedUserId: "deferred-user",
    accountId: "account",
  });
  expect(emit()).toMatchObject(before);
});

it("cancels deferred SDK cookie writes on shutdown and ignores stale enable calls", async () => {
  const { handle, emit } = await initialize({
    storage: { enabled: false },
    cookieCfg: { enabled: false },
  });
  handle.userContext.setAuthenticatedUserContext("queued-user", undefined, true);
  const attributes = emit();
  const manager = handle.getCookieMgr();
  expect(manager.get("opentelemetry-session")).not.toBe("");
  expect(manager.get("opentelemetry-auth-user")).not.toBe("");
  expect(attributes["user.id"]).toBe("queued-user");
  const tracer = trace.getTracer("stale");
  const logger = logs.getLogger("stale");
  await handle.shutdown();
  const write = vi.spyOn(document, "cookie", "set");
  manager.setEnabled(true);
  handle.userContext.setEnabled(true);
  handle.userContext.setAuthenticatedUserContext("stale-user", undefined, true);
  tracer.startSpan("after-shutdown").end();
  logger.emit({});
  expect(manager.isEnabled()).toBe(false);
  expect(manager.get("opentelemetry-session")).toBe("");
  expect(manager.get("opentelemetry-auth-user")).toBe("");
  expect(write).not.toHaveBeenCalled();
  expect(document.cookie).toBe("");
});

it.each([false, null, [], true, 0, "", "disabled", () => {}])(
  "rejects a malformed storage container before accessing browser storage (%j)",
  async (storage) => {
    for (const key of keys) preserve(key);
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    const cookie = vi.spyOn(document, "cookie", "get");
    await expect(
      initialize({
        // @ts-expect-error Verify untyped JavaScript input.
        storage,
      }),
    ).rejects.toThrow("storage must be a non-null, non-array object.");
    expect(local).not.toHaveBeenCalled();
    expect(session).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
  },
);

it.each(["inherited getters", "non-enumerable properties"])(
  "preserves session persistence and lifetime settings supplied through %s",
  async (kind) => {
    preserve("opentelemetry-session");
    class SessionOptions {
      get persist() {
        return false;
      }
      get inactivityTimeout() {
        return 1;
      }
      get maxDuration() {
        return 3;
      }
    }
    const session =
      kind === "inherited getters"
        ? new SessionOptions()
        : Object.defineProperties(
            {},
            {
              persist: { value: false },
              inactivityTimeout: { value: 1 },
              maxDuration: { value: 3 },
            },
          );
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const access = vi.spyOn(window, "localStorage", "get");
    const { emit, handle } = await initialize({ session, userContext: { enabled: false } });
    const first = emit()["session.id"];
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    clock.mockReturnValue(now + 1000);
    const renewed = emit()["session.id"];
    expect(renewed).not.toBe(first);
    for (const offset of [1500, 2000, 2500, 3000, 3500]) {
      clock.mockReturnValue(now + offset);
      expect(emit()["session.id"]).toBe(renewed);
    }
    clock.mockReturnValue(now + 4000);
    expect(emit()["session.id"]).not.toBe(renewed);
    await handle.shutdown();
    expect(access).not.toHaveBeenCalled();
  },
);

it.each([{ enabled: "false" }, { enabled: null }, { namePrefix: 42 }, { namePrefix: null }])(
  "rejects invalid storage options before accessing storage (%j)",
  async (storage) => {
    const access = vi.spyOn(window, "localStorage", "get");
    await expect(
      useMicrosoftOpenTelemetry({
        // @ts-expect-error Verify untyped JavaScript input.
        storage,
      }),
    ).rejects.toThrow("storage.enabled must be a boolean and storage.namePrefix a string.");
    expect(access).not.toHaveBeenCalled();
  },
);

it("accepts an empty prefix in the loader and validates storage options", () => {
  expect(
    getSdkLoaderScript({ connectionString: "connection", storage: { namePrefix: "" } }),
  ).toContain('"storage":{"namePrefix":""}');
  for (const storage of [{ enabled: "false" }, { namePrefix: 42 }]) {
    expect(() =>
      getSdkLoaderScript({
        connectionString: "connection",
        // @ts-expect-error Verify untyped JavaScript input.
        storage,
      }),
    ).toThrow(TypeError);
  }
});
