// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import { afterEach, expect, it, vi } from "vitest";
import { createCookieManager } from "../../../src/storage/cookieManager.js";
import type { MicrosoftOpenTelemetryBrowserCookieManager } from "../../../src/types.js";
import { createCookieUserContext } from "../../../src/user/createCookieUserContext.js";

const anonymousCookie = "opentelemetry-user";
const authenticatedCookie = "opentelemetry-auth-user";
const encode = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const decode = (value: string) => JSON.parse(decodeURIComponent(value));

function fakeManager() {
  const values = new Map<string, string>();
  const cookies = {
    isEnabled: vi.fn(() => true),
    setEnabled: vi.fn(),
    get: vi.fn((name: string) => values.get(name) ?? ""),
    set: vi.fn((name: string, value: string, _maxAgeSec?: number) => {
      values.set(name, value);
      return true;
    }),
    del: vi.fn((name: string) => {
      values.delete(name);
      return true;
    }),
    purge: vi.fn((name: string) => {
      values.delete(name);
      return true;
    }),
  } satisfies MicrosoftOpenTelemetryBrowserCookieManager;
  return { cookies, values };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([undefined, true])("creates a year-long anonymous cookie when enabled is %s", (enabled) => {
  const local = vi.spyOn(window, "localStorage", "get");
  const session = vi.spyOn(window, "sessionStorage", "get");
  vi.spyOn(Date, "now").mockReturnValue(123456);
  const { cookies, values } = fakeManager();
  const { provider } = createCookieUserContext(enabled, cookies);
  const anonymousId = provider.getAnonymousUserId();
  expect(anonymousId).toMatch(/^[0-9a-f]{32}$/);
  expect(decode(values.get(anonymousCookie)!)).toEqual({
    anonymousId,
    acquisitionTimestamp: 123456,
  });
  expect(cookies.set).toHaveBeenCalledExactlyOnceWith(
    anonymousCookie,
    values.get(anonymousCookie),
    31536000,
  );
  expect(provider.getAuthenticatedUserId()).toBeUndefined();
  expect(provider.getAccountId()).toBeUndefined();
  expect(local).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
  expect(cookies.isEnabled).not.toHaveBeenCalled();
});

it("uses Web Crypto and falls back when it is missing or throws", () => {
  vi.spyOn(crypto, "getRandomValues").mockImplementationOnce((array) => {
    (array as Uint8Array).fill(171);
    return array;
  });
  expect(createCookieUserContext(true, fakeManager().cookies).provider.getAnonymousUserId()).toBe(
    "ab".repeat(16),
  );
  vi.spyOn(crypto, "getRandomValues").mockImplementation(() => {
    throw new Error("restricted");
  });
  expect(
    createCookieUserContext(true, fakeManager().cookies).provider.getAnonymousUserId(),
  ).toMatch(/^[0-9a-f]{32}$/);
  vi.stubGlobal("crypto", undefined);
  expect(
    createCookieUserContext(true, fakeManager().cookies).provider.getAnonymousUserId(),
  ).toMatch(/^[0-9a-f]{32}$/);
});

it("restores independently encoded identities without rewriting or copying extra fields", () => {
  const { cookies, values } = fakeManager();
  values.set(anonymousCookie, encode({ anonymousId: "anonymous", acquisitionTimestamp: 42 }));
  values.set(
    authenticatedCookie,
    encode({
      authenticatedUserId: "user;|= 雪",
      accountId: "account,;\n",
      anonymousId: "wrong",
      __proto__: { polluted: true },
    }),
  );
  const { provider } = createCookieUserContext(true, cookies);
  expect(provider.getAnonymousUserId()).toBe("anonymous");
  expect(provider.getAuthenticatedUserId()).toBe("user;|= 雪");
  expect(provider.getAccountId()).toBe("account,;\n");
  expect(cookies.set).not.toHaveBeenCalled();
});

it("isolates prefixed cookies and leaves other applications untouched", () => {
  const { cookies, values } = fakeManager();
  const first = createCookieUserContext(true, cookies, "first-");
  const second = createCookieUserContext(true, cookies, "second-");
  first.context.setAuthenticatedUserContext("first", undefined, true);
  second.context.setAuthenticatedUserContext("second", "account", true);
  first.context.setEnabled(false);
  expect(values.has(`first-${anonymousCookie}`)).toBe(false);
  expect(values.has(`first-${authenticatedCookie}`)).toBe(false);
  expect(decode(values.get(`second-${authenticatedCookie}`)!)).toEqual({
    authenticatedUserId: "second",
    accountId: "account",
  });
  expect(second.provider.getAnonymousUserId()).toBeDefined();
});

it("does not access cookies when initially disabled, but supports memory-only authentication", () => {
  const { cookies } = fakeManager();
  const { context, provider } = createCookieUserContext(false, cookies);
  context.setAuthenticatedUserContext("user", "account", true);
  expect(provider.getAnonymousUserId()).toBeUndefined();
  expect(provider.getAuthenticatedUserId()).toBe("user");
  expect(provider.getAccountId()).toBe("account");
  for (const operation of Object.values(cookies)) expect(operation).not.toHaveBeenCalled();
  context.setEnabled(true);
  expect(provider.getAnonymousUserId()).toBeDefined();
  expect(cookies.set.mock.calls.map(([name]) => name)).toEqual([
    anonymousCookie,
    authenticatedCookie,
  ]);
});

it("persists authentication only on explicit opt-in and never gives auth cookies a lifetime", () => {
  const { cookies, values } = fakeManager();
  const { context, provider } = createCookieUserContext(true, cookies);
  context.setAuthenticatedUserContext("user", "account");
  expect(provider.getAuthenticatedUserId()).toBe("user");
  expect(values.has(authenticatedCookie)).toBe(false);
  context.setAuthenticatedUserContext("user;|= 雪", "account,;\n", true);
  expect(cookies.set).toHaveBeenLastCalledWith(
    authenticatedCookie,
    encode({ authenticatedUserId: "user;|= 雪", accountId: "account,;\n" }),
  );
  context.setAuthenticatedUserContext("replacement");
  expect(provider.getAccountId()).toBeUndefined();
  expect(values.has(authenticatedCookie)).toBe(false);
  context.setEnabled(false);
  context.setEnabled(true);
  expect(values.has(authenticatedCookie)).toBe(false);
});

it.each([false, true])(
  "preserves explicit auth storage preference %s across disable/enable",
  (store) => {
    const { cookies, values } = fakeManager();
    const { context, provider } = createCookieUserContext(true, cookies);
    const id = provider.getAnonymousUserId();
    context.setAuthenticatedUserContext("user", "account", store);
    context.setEnabled(false);
    expect(provider.getAnonymousUserId()).toBeUndefined();
    expect(provider.getAuthenticatedUserId()).toBe("user");
    expect(provider.getAccountId()).toBe("account");
    expect(values.size).toBe(0);
    expect(cookies.purge.mock.calls).toEqual([[anonymousCookie], [authenticatedCookie]]);
    context.setEnabled(true);
    expect(provider.getAnonymousUserId()).toBe(id);
    expect(values.has(authenticatedCookie)).toBe(store);
  },
);

it("does not implicitly persist a memory-only login set while context is disabled", () => {
  const { cookies, values } = fakeManager();
  const { context } = createCookieUserContext(false, cookies);
  context.setAuthenticatedUserContext("user");
  context.setEnabled(true);
  expect(values.has(authenticatedCookie)).toBe(false);
});

it.each([false, true])(
  "clear auth removes memory and uses del even when context enabled is %s",
  (enabled) => {
    const { cookies, values } = fakeManager();
    const { context, provider } = createCookieUserContext(enabled, cookies);
    context.setAuthenticatedUserContext("user", "account", true);
    context.clearAuthenticatedUserContext();
    expect(provider.getAuthenticatedUserId()).toBeUndefined();
    expect(provider.getAccountId()).toBeUndefined();
    expect(values.has(authenticatedCookie)).toBe(false);
    expect(cookies.del).toHaveBeenLastCalledWith(authenticatedCookie);
    expect(cookies.purge).not.toHaveBeenCalled();
    context.setEnabled(true);
    expect(values.has(authenticatedCookie)).toBe(false);
  },
);

it.each(["", null, 123, {}, false])(
  "validates ID %j without altering identity or persistence",
  (invalid) => {
    const { cookies, values } = fakeManager();
    const { context, provider } = createCookieUserContext(true, cookies);
    context.setAuthenticatedUserContext("user", "account", true);
    const stored = values.get(authenticatedCookie);
    expect(() => context.setAuthenticatedUserContext(invalid as string)).toThrow(TypeError);
    expect(() => context.setAuthenticatedUserContext("new", invalid as string)).toThrow(TypeError);
    expect(provider.getAuthenticatedUserId()).toBe("user");
    expect(provider.getAccountId()).toBe("account");
    expect(values.get(authenticatedCookie)).toBe(stored);
  },
);

it.each([
  "%",
  "%E0%A4%A",
  encode("private-user"),
  encode(null),
  encode([]),
  encode({}),
  encode({ anonymousId: "", acquisitionTimestamp: 42 }),
  encode({ anonymousId: "private-user" }),
  encode({ anonymousId: "private-user", acquisitionTimestamp: "42" }),
  encode({ anonymousId: "private-user", acquisitionTimestamp: -1 }),
  encode({ anonymousId: "private-user", acquisitionTimestamp: null }),
  encodeURIComponent('{"anonymousId":"private-user","acquisitionTimestamp":1e400}'),
  encodeURIComponent('{"__proto__":{"anonymousId":"private-user","acquisitionTimestamp":42}}'),
])("recovers malformed anonymous cookie %s without logging identity", (value) => {
  const warn = vi.spyOn(diag, "warn");
  const { cookies, values } = fakeManager();
  values.set(anonymousCookie, value);
  const { provider } = createCookieUserContext(true, cookies);
  expect(provider.getAnonymousUserId()).toMatch(/^[0-9a-f]{32}$/);
  expect(decode(values.get(anonymousCookie)!).anonymousId).toBe(provider.getAnonymousUserId());
  expect(warn).not.toHaveBeenCalled();
});

it.each([
  "%",
  encode(null),
  encode([]),
  encode({}),
  encode({ authenticatedUserId: "" }),
  encode({ authenticatedUserId: "private-user", accountId: "" }),
  encode({ authenticatedUserId: "private-user", accountId: null }),
  encode({ authenticatedUserId: 42 }),
  encodeURIComponent('{"__proto__":{"authenticatedUserId":"private-user"}}'),
])("removes malformed auth cookie %s without restoring or logging it", (value) => {
  const warn = vi.spyOn(diag, "warn");
  const { cookies, values } = fakeManager();
  values.set(authenticatedCookie, value);
  const { provider } = createCookieUserContext(true, cookies);
  expect(provider.getAuthenticatedUserId()).toBeUndefined();
  expect(provider.getAccountId()).toBeUndefined();
  expect(values.has(authenticatedCookie)).toBe(false);
  expect(warn).not.toHaveBeenCalled();
});

it("ignores inherited fields and never assigns a parsed prototype", () => {
  const inherited = vi.spyOn(Object.prototype, "hasOwnProperty");
  const { cookies, values } = fakeManager();
  values.set(
    authenticatedCookie,
    encodeURIComponent('{"authenticatedUserId":"user","__proto__":{"polluted":true}}'),
  );
  const { provider } = createCookieUserContext(true, cookies);
  expect(provider.getAuthenticatedUserId()).toBe("user");
  expect(provider.getAccountId()).toBeUndefined();
  expect(Object.prototype).not.toHaveProperty("polluted");
  expect(inherited).toHaveBeenCalled();
});

it.each([anonymousCookie, authenticatedCookie])(
  "contains initialization read failures for %s and retries anonymous reads independently",
  (failedName) => {
    const { cookies } = fakeManager();
    cookies.get.mockImplementation((name) => {
      if (name === failedName) throw new Error("private identity");
      return "";
    });
    const { context, provider } = createCookieUserContext(true, cookies);
    expect(cookies.set).not.toHaveBeenCalled();
    expect(provider.getAnonymousUserId() !== undefined).toBe(failedName === authenticatedCookie);
    context.setAuthenticatedUserContext("memory-user");
    expect(provider.getAuthenticatedUserId()).toBe("memory-user");
    cookies.get.mockReturnValue("");
    context.setEnabled(true);
    expect(provider.getAnonymousUserId()).toBeDefined();
  },
);

it.each(["false", "throw"])(
  "suppresses anonymous enrichment after %s writes and can recover",
  (failure) => {
    const { cookies } = fakeManager();
    cookies.set.mockImplementation(() => {
      if (failure === "throw") throw new Error("private identity");
      return false;
    });
    const { context, provider } = createCookieUserContext(true, cookies);
    expect(provider.getAnonymousUserId()).toBeUndefined();
    context.setEnabled(true);
    expect(provider.getAnonymousUserId()).toBeUndefined();
    cookies.set.mockReturnValue(true);
    context.setEnabled(true);
    expect(provider.getAnonymousUserId()).toBeDefined();
  },
);

it("keeps auth in memory and removes stale auth after a failed replacement", () => {
  const { cookies, values } = fakeManager();
  const { context, provider } = createCookieUserContext(true, cookies);
  context.setAuthenticatedUserContext("old", undefined, true);
  cookies.set.mockReturnValue(false);
  context.setAuthenticatedUserContext("new", undefined, true);
  expect(provider.getAuthenticatedUserId()).toBe("new");
  expect(values.has(authenticatedCookie)).toBe(false);
});

it("attempts both purges and clears enrichment even when cleanup throws", () => {
  const { cookies } = fakeManager();
  const { context, provider } = createCookieUserContext(true, cookies);
  cookies.purge.mockImplementation(() => {
    throw new Error("denied");
  });
  context.setEnabled(false);
  expect(provider.getAnonymousUserId()).toBeUndefined();
  expect(cookies.purge.mock.calls).toEqual([[anonymousCookie], [authenticatedCookie]]);
});

it("allows deferred anonymous identity but disable purges pending identities without resurrection", () => {
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const cookies = createCookieManager({ enabled: false, setCookie, delCookie });
  const { context, provider } = createCookieUserContext(true, cookies);
  expect(provider.getAnonymousUserId()).toBeDefined();
  context.setAuthenticatedUserContext("user", "account", true);
  expect(setCookie).not.toHaveBeenCalled();
  context.setEnabled(false);
  expect(delCookie.mock.calls.map(([name]) => name)).toEqual([
    anonymousCookie,
    authenticatedCookie,
  ]);
  expect(cookies.get(anonymousCookie)).toBe("");
  expect(cookies.get(authenticatedCookie)).toBe("");
  cookies.setEnabled(true);
  expect(setCookie).not.toHaveBeenCalled();
});

it("honors disabled deferral and replaces pending auth writes with deferred deletes on clear", () => {
  const unavailable = createCookieManager({ enabled: false, disableCookieDefer: true });
  expect(createCookieUserContext(true, unavailable).provider.getAnonymousUserId()).toBeUndefined();
  const setCookie = vi.fn();
  const delCookie = vi.fn();
  const cookies = createCookieManager({ enabled: false, setCookie, delCookie });
  const { context } = createCookieUserContext(true, cookies);
  context.setAuthenticatedUserContext("user", undefined, true);
  context.clearAuthenticatedUserContext();
  expect(delCookie).not.toHaveBeenCalled();
  cookies.setEnabled(true);
  expect(setCookie.mock.calls.map(([name]) => name)).toEqual([anonymousCookie]);
  expect(delCookie.mock.calls.map(([name]) => name)).toEqual([authenticatedCookie]);
});

it("clears persisted authentication after cookie-manager shutdown without resuming writes", () => {
  const values = new Map<string, string>();
  const setCookie = vi.fn((name: string, value: string) => values.set(name, value));
  const delCookie = vi.fn((name: string) => values.delete(name));
  const cookies = createCookieManager({
    getCookie: (name) => values.get(name) ?? "",
    setCookie,
    delCookie,
  });
  const { context, provider } = createCookieUserContext(true, cookies);
  context.setAuthenticatedUserContext("old-user", "account", true);
  expect(values.has(authenticatedCookie)).toBe(true);
  cookies.shutdown();
  setCookie.mockClear();
  context.clearAuthenticatedUserContext();
  expect(values.has(authenticatedCookie)).toBe(false);
  expect(provider.getAuthenticatedUserId()).toBeUndefined();
  expect(provider.getAccountId()).toBeUndefined();
  expect(delCookie).toHaveBeenCalledWith(authenticatedCookie, expect.stringContaining("max-age=0"));
  cookies.setEnabled(true);
  expect(setCookie).not.toHaveBeenCalled();
});

it.each([false, true])(
  "recovers anonymous enrichment on telemetry after cookie enablement (existing cookie: %s) without auth replay",
  (existing) => {
    const { values } = fakeManager();
    if (existing) {
      values.set(
        anonymousCookie,
        encode({ anonymousId: "existing-user", acquisitionTimestamp: 42 }),
      );
    }
    values.set(authenticatedCookie, encode({ authenticatedUserId: "old-login" }));
    const setCookie = vi.fn((name: string, value: string) => values.set(name, value));
    const cookies = createCookieManager({
      enabled: false,
      disableCookieDefer: true,
      getCookie: (name) => values.get(name) ?? "",
      setCookie,
    });
    const onNewUser = vi.fn();
    const { context, provider } = createCookieUserContext(true, cookies, "", onNewUser);
    context.setAuthenticatedUserContext("current-login", undefined, true);
    expect(provider.getAnonymousUserId()).toBeUndefined();
    expect(onNewUser).not.toHaveBeenCalled();
    cookies.setEnabled(true);
    const id = provider.getAnonymousUserId();
    expect(id).toEqual(existing ? "existing-user" : expect.stringMatching(/^[0-9a-f]{32}$/));
    expect(provider.getAnonymousUserId()).toBe(id);
    expect(provider.getAuthenticatedUserId()).toBe("current-login");
    expect(onNewUser).toHaveBeenCalledTimes(existing ? 0 : 1);
    expect(setCookie.mock.calls.map(([name]) => name)).toEqual(existing ? [] : [anonymousCookie]);
  },
);

it.each(["", "%", encode({ anonymousId: "invalid" })])(
  "notifies a new user before saving a missing or invalid anonymous cookie %s",
  (value) => {
    const { cookies, values } = fakeManager();
    values.set(anonymousCookie, value);
    const onNewUser = vi.fn(() => {
      expect(cookies.set).not.toHaveBeenCalled();
    });
    createCookieUserContext(true, cookies, "", onNewUser);
    expect(onNewUser).toHaveBeenCalledExactlyOnceWith();
    expect(cookies.set).toHaveBeenCalledTimes(1);
  },
);

it("does not notify a new user for an existing valid anonymous cookie", () => {
  const { cookies, values } = fakeManager();
  values.set(anonymousCookie, encode({ anonymousId: "existing-user", acquisitionTimestamp: 42 }));
  const onNewUser = vi.fn();
  const { provider } = createCookieUserContext(true, cookies, "", onNewUser);
  expect(provider.getAnonymousUserId()).toBe("existing-user");
  expect(onNewUser).not.toHaveBeenCalled();
  expect(cookies.set).not.toHaveBeenCalled();
});

it.each(["disabled", "unavailable", "throws"])(
  "does not notify a new user while cookie access is %s",
  (state) => {
    const { cookies } = fakeManager();
    cookies.isEnabled.mockImplementation(() => {
      if (state === "throws") throw new Error("denied");
      return false;
    });
    const onNewUser = vi.fn();
    const { provider } = createCookieUserContext(true, cookies, "", onNewUser);
    provider.getAnonymousUserId();
    expect(onNewUser).not.toHaveBeenCalled();
  },
);

it("does not access cookies or notify new users while user context is disabled", () => {
  const { cookies } = fakeManager();
  const onNewUser = vi.fn();
  const { context, provider } = createCookieUserContext(false, cookies, "", onNewUser);
  expect(provider.getAnonymousUserId()).toBeUndefined();
  expect(onNewUser).not.toHaveBeenCalled();
  expect(cookies.isEnabled).not.toHaveBeenCalled();
  context.setEnabled(true);
  expect(onNewUser).toHaveBeenCalledTimes(1);
  expect(provider.getAnonymousUserId()).toBeDefined();
});

it("bounds new-user notification across failed retries and contains callback failures", () => {
  const { cookies } = fakeManager();
  cookies.set.mockReturnValue(false);
  const onNewUser = vi.fn(() => {
    throw new Error("backup cleanup failed");
  });
  const { provider } = createCookieUserContext(true, cookies, "", onNewUser);
  expect(provider.getAnonymousUserId()).toBeUndefined();
  expect(provider.getAnonymousUserId()).toBeUndefined();
  expect(onNewUser).toHaveBeenCalledTimes(1);
  cookies.set.mockReturnValue(true);
  expect(provider.getAnonymousUserId()).toBeDefined();
});
