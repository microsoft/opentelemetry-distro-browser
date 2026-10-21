// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSession } from "../../../src/session/createSession.js";
import { createCookieManager } from "../../../src/storage/cookieManager.js";
import type { KeyValueStorage } from "../../../src/storage/keyValueStorage.js";
import type { MicrosoftOpenTelemetryBrowserCookieManager } from "../../../src/types.js";

const key = "opentelemetry-session";
const encode = (value: unknown) => encodeURIComponent(JSON.stringify(value));
const decode = (value: string) => JSON.parse(decodeURIComponent(value));

function fakeBackends() {
  const values = new Map<string, string>();
  const cookies = {
    isEnabled: vi.fn(() => true),
    setEnabled: vi.fn(),
    get: vi.fn((name: string) => values.get(name) ?? ""),
    set: vi.fn((name: string, value: string, _maxAgeSec?: number) => {
      values.set(name, value);
      return true;
    }),
    del: vi.fn(() => true),
    purge: vi.fn(() => true),
  } satisfies MicrosoftOpenTelemetryBrowserCookieManager;
  const storage = {
    getItem: vi.fn((_name: string) => ({ success: true as const, value: null as string | null })),
    setItem: vi.fn((_name: string, _value: string) => true),
    removeItem: vi.fn(() => true),
  } satisfies KeyValueStorage;
  return { cookies, storage, values };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("restores the complete prefixed cookie first without reading or writing storage", async () => {
  const { cookies, storage, values } = fakeBackends();
  const record = { id: "cookie; 雪", startTimestamp: 900_000, lastActivityTimestamp: 990_000 };
  values.set(`app-${key}`, encode(record));
  storage.getItem.mockReturnValue({
    success: true,
    value: JSON.stringify({ ...record, id: "backup" }),
  });
  const session = createSession({}, storage, cookies, `app-${key}`);
  await session.start();
  expect(session.getSessionId()).toBe(record.id);
  expect(cookies.get).toHaveBeenCalledExactlyOnceWith(`app-${key}`);
  expect(decode(values.get(`app-${key}`)!)).toEqual({
    ...record,
    lastActivityTimestamp: Date.now(),
  });
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(storage.setItem).not.toHaveBeenCalled();
  session.shutdown();
});

it("falls back to a missing cookie's storage backup and migrates it on activity", async () => {
  const { cookies, storage, values } = fakeBackends();
  storage.getItem.mockReturnValue({
    success: true,
    value: JSON.stringify({
      id: "backup",
      startTimestamp: 900_000,
      lastActivityTimestamp: 990_000,
    }),
  });
  const session = createSession({}, storage, cookies);
  await session.start();
  expect(session.getSessionId()).toBe("backup");
  expect(storage.getItem).toHaveBeenCalledExactlyOnceWith(key);
  expect(decode(values.get(key)!)).toEqual({
    id: "backup",
    startTimestamp: 900_000,
    lastActivityTimestamp: Date.now(),
  });
  expect(storage.setItem).not.toHaveBeenCalled();
});

it("never restores a discarded user backup even when its removal fails", async () => {
  const { cookies, storage } = fakeBackends();
  storage.getItem.mockReturnValue({
    success: true,
    value: JSON.stringify({ id: "previous-user", startTimestamp: Date.now() }),
  });
  storage.removeItem.mockReturnValue(false);
  const session = createSession({}, storage, cookies);
  session.discardBackup();
  await session.start();
  expect(session.getSessionId()).not.toBe("previous-user");
  expect(storage.getItem).not.toHaveBeenCalled();
  session.shutdown();
});

it("does not clear Web Storage for memory-only sessions on a user reset", async () => {
  const { cookies, storage } = fakeBackends();
  const session = createSession({ persist: false }, storage, cookies);
  session.discardBackup();
  await session.start();
  expect(storage.removeItem).not.toHaveBeenCalled();
  expect(storage.getItem).not.toHaveBeenCalled();
  expect(cookies.get).not.toHaveBeenCalled();
  session.shutdown();
});

it.each([
  "%",
  "%E0%A4%A",
  "not-json",
  encode(null),
  encode({ id: "invalid" }),
  encode({ id: "future", startTimestamp: 1_000_001 }),
  encode({ id: "invalid-activity", startTimestamp: 900_000, lastActivityTimestamp: 899_999 }),
])("does not fall back from a present malformed cookie (%s)", async (value) => {
  const { cookies, storage, values } = fakeBackends();
  values.set(key, value);
  storage.getItem.mockReturnValue({
    success: true,
    value: JSON.stringify({ id: "backup", startTimestamp: Date.now() }),
  });
  const session = createSession({}, storage, cookies);
  await session.start();
  expect(session.getSessionId()).toMatch(/^[0-9a-f]{32}$/);
  expect(storage.getItem).not.toHaveBeenCalled();
});

it.each([
  [120, 300, 120],
  [300, 120, 120],
  [0, 120, 120],
  [120, 0, undefined],
  [0, 0, undefined],
] as const)(
  "sets cookie age for inactivity=%s, maximum=%s",
  async (inactivityTimeout, maxDuration, age) => {
    const { cookies, storage } = fakeBackends();
    const session = createSession({ inactivityTimeout, maxDuration }, storage, cookies);
    await session.start();
    const id = session.getSessionId();
    expect(cookies.set).toHaveBeenCalledExactlyOnceWith(
      key,
      encode({
        id,
        startTimestamp: Date.now(),
        lastActivityTimestamp: Date.now(),
      }),
      age,
    );
  },
);

it("throttles refreshes at 60 seconds while preserving latest activity and remaining maximum age", async () => {
  const { cookies, storage, values } = fakeBackends();
  const start = Date.now();
  const session = createSession({ inactivityTimeout: 120, maxDuration: 150 }, storage, cookies);
  await session.start();
  const id = session.getSessionId();
  for (const elapsed of [1, 30_000, 59_999]) {
    vi.setSystemTime(start + elapsed);
    expect(session.getSessionId()).toBe(id);
  }
  expect(cookies.set).toHaveBeenCalledTimes(1);
  vi.setSystemTime(start + 60_000);
  expect(session.getSessionId()).toBe(id);
  expect(cookies.set).toHaveBeenLastCalledWith(
    key,
    encode({
      id,
      startTimestamp: start,
      lastActivityTimestamp: start + 60_000,
    }),
    90,
  );
  expect(decode(values.get(key)!)).toHaveProperty("lastActivityTimestamp", start + 60_000);
  expect(storage.setItem).not.toHaveBeenCalled();
});

it.each(["inactivityTimeout", "maxDuration"] as const)(
  "renews at the exact %s boundary despite throttling",
  async (option) => {
    const { cookies, storage, values } = fakeBackends();
    const session = createSession({ [option]: 2 }, storage, cookies);
    await session.start();
    const id = session.getSessionId();
    vi.setSystemTime(Date.now() + 2000);
    expect(session.getSessionId()).not.toBe(id);
    expect(cookies.set).toHaveBeenCalledTimes(2);
    expect(decode(values.get(key)!)).toHaveProperty("startTimestamp", Date.now());
  },
);

it("renews immediately after timestamp regression", async () => {
  const { cookies, storage } = fakeBackends();
  const session = createSession({}, storage, cookies);
  await session.start();
  const id = session.getSessionId();
  vi.setSystemTime(Date.now() + 1000);
  expect(session.getSessionId()).toBe(id);
  vi.setSystemTime(Date.now() - 1);
  expect(session.getSessionId()).not.toBe(id);
  expect(cookies.set).toHaveBeenCalledTimes(2);
});

it.each([
  { id: "idle", startTimestamp: 900_000, lastActivityTimestamp: 998_000 },
  { id: "old", startTimestamp: 998_000, lastActivityTimestamp: 999_999 },
])("rejects expired cookie sessions without restoring a backup ($id)", async (record) => {
  const { cookies, storage, values } = fakeBackends();
  values.set(key, encode(record));
  const session = createSession({ inactivityTimeout: 2, maxDuration: 2 }, storage, cookies);
  await session.start();
  expect(session.getSessionId()).not.toBe(record.id);
  expect(storage.getItem).not.toHaveBeenCalled();
});

it("backs up only explicitly, using current activity without refreshing cookies", async () => {
  const { cookies, storage } = fakeBackends();
  const session = createSession({}, storage, cookies);
  session.backup();
  expect(storage.setItem).not.toHaveBeenCalled();
  await session.start();
  const start = Date.now();
  const id = session.getSessionId();
  vi.setSystemTime(start + 1234);
  session.getSessionId();
  session.shutdown();
  expect(storage.setItem).not.toHaveBeenCalled();
  session.backup();
  expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
    key,
    JSON.stringify({
      id,
      startTimestamp: start,
      lastActivityTimestamp: start + 1234,
    }),
  );
  expect(cookies.set).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "does not touch either backend when persist=false (cookies=%s)",
  async (cookieMode) => {
    const { cookies, storage } = fakeBackends();
    const session = createSession(
      { persist: false, inactivityTimeout: 1 },
      storage,
      cookieMode ? cookies : undefined,
    );
    await session.start();
    const id = session.getSessionId();
    vi.setSystemTime(Date.now() + 1000);
    expect(session.getSessionId()).not.toBe(id);
    session.backup();
    session.shutdown();
    for (const method of [...Object.values(cookies), ...Object.values(storage)]) {
      expect(method).not.toHaveBeenCalled();
    }
  },
);

it.each([false, true])(
  "null storage never accesses Web Storage (cookies=%s)",
  async (cookieMode) => {
    const local = vi.spyOn(window, "localStorage", "get");
    const { cookies } = fakeBackends();
    const session = createSession({}, null, cookieMode ? cookies : undefined);
    await session.start();
    expect(session.getSessionId()).toMatch(/^[0-9a-f]{32}$/);
    session.backup();
    session.shutdown();
    expect(local).not.toHaveBeenCalled();
    expect(cookies.set).toHaveBeenCalledTimes(cookieMode ? 1 : 0);
  },
);

it.each([false, true])(
  "honors disabled-cookie deferral independently of explicit backup (disableCookieDefer=%s)",
  async (disableCookieDefer) => {
    const setCookie = vi.fn();
    const cookies = createCookieManager({ enabled: false, disableCookieDefer, setCookie });
    const { storage } = fakeBackends();
    const session = createSession({}, storage, cookies);
    await session.start();
    const start = Date.now();
    const id = session.getSessionId();
    vi.setSystemTime(start + 60_000);
    expect(session.getSessionId()).toBe(id);
    expect(setCookie).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    session.backup();
    expect(storage.setItem).toHaveBeenCalledOnce();
    cookies.setEnabled(true);
    if (disableCookieDefer) expect(setCookie).not.toHaveBeenCalled();
    else {
      expect(setCookie).toHaveBeenCalledOnce();
      expect(decode(setCookie.mock.calls[0][1].split(";")[0])).toEqual({
        id,
        startTimestamp: start,
        lastActivityTimestamp: start + 60_000,
      });
    }
    session.shutdown();
    cookies.shutdown();
  },
);

it("keeps the legacy storage path writing on each activity without cookie encoding", async () => {
  const { storage } = fakeBackends();
  const session = createSession({}, storage);
  await session.start();
  const start = Date.now();
  const id = session.getSessionId();
  vi.setSystemTime(start + 1);
  expect(session.getSessionId()).toBe(id);
  expect(storage.setItem).toHaveBeenCalledTimes(2);
  expect(storage.setItem).toHaveBeenLastCalledWith(
    key,
    JSON.stringify({
      id,
      startTimestamp: start,
      lastActivityTimestamp: start + 1,
    }),
  );
});
