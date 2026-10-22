// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import {
  createDefaultSessionIdGenerator,
  createSessionManager,
} from "@opentelemetry/browser-sdk/session";
import type { Session, SessionStore } from "@opentelemetry/browser-sdk/session";
import { createKeyValueStorage, type KeyValueStorage } from "../storage/keyValueStorage.js";
import type {
  MicrosoftOpenTelemetryBrowserCookieManager,
  MicrosoftOpenTelemetryBrowserSessionOptions,
} from "../types.js";

const storageKey = "opentelemetry-session";

function lifetimeSeconds(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`session.${name} must be a finite, nonnegative number of seconds.`);
  }
  return value;
}

/**
 * Creates a session using legacy Web Storage persistence unless a cookie manager is supplied.
 * In cookie mode, storage is only a restoration fallback and an explicit `backup()` target;
 * pass `null` to disable Web Storage (passing `undefined` selects the legacy default).
 * The caller supplies the complete cookie name, including any instance prefix, and calls
 * `backup()` on unload/shutdown. Cookie policy and deferred writes belong to the manager.
 */
export function createSession(
  options: MicrosoftOpenTelemetryBrowserSessionOptions,
  storage: KeyValueStorage | null = createKeyValueStorage(
    "localStorage",
    "Session storage unavailable; using an in-memory session.",
  ),
  cookies?: MicrosoftOpenTelemetryBrowserCookieManager,
  cookieName = storageKey,
) {
  const inactivityTimeout = lifetimeSeconds(
    options.inactivityTimeout,
    30 * 60,
    "inactivityTimeout",
  );
  const maxDuration = lifetimeSeconds(options.maxDuration, 24 * 60 * 60, "maxDuration");
  const persist = options.persist === undefined ? true : options.persist;
  if (typeof persist !== "boolean") throw new TypeError("session.persist must be a boolean.");
  let lastActivityTimestamp = Date.now();
  let currentSession: Session | undefined;
  let lastCookieWrite: number | undefined;
  let ignoreBackup = false;

  function expired(session: Session, now: number): boolean {
    return (
      now < session.startTimestamp ||
      now < lastActivityTimestamp ||
      (inactivityTimeout > 0 && (now - lastActivityTimestamp) / 1000 >= inactivityTimeout) ||
      (maxDuration > 0 && (now - session.startTimestamp) / 1000 >= maxDuration)
    );
  }

  function serialize(session: Session): string {
    return JSON.stringify({ ...session, lastActivityTimestamp });
  }

  function save(session: Session, force = false): void {
    // Keep errors synchronous because upstream does not await saves.
    if (!persist) return;
    if (!cookies) {
      storage?.setItem(storageKey, serialize(session));
      return;
    }
    const now = Date.now();
    if (
      !force &&
      lastCookieWrite !== undefined &&
      now >= lastCookieWrite &&
      (now === lastCookieWrite ||
        ((inactivityTimeout === 0 || inactivityTimeout > 60) && now - lastCookieWrite < 60_000))
    ) {
      return;
    }
    // Short inactivity windows need each activity persisted to survive reloads.
    // A rejected renewal must not inherit the previous session's accepted-write throttle.
    lastCookieWrite = undefined;
    // Round cookie retention up to whole seconds; timestamps enforce the exact session deadline.
    const maxAge =
      maxDuration === 0
        ? undefined
        : Math.ceil(
            Math.max(
              0,
              Math.min(
                maxDuration - (now - session.startTimestamp) / 1000,
                inactivityTimeout > 0
                  ? inactivityTimeout - (now - lastActivityTimestamp) / 1000
                  : Infinity,
              ),
            ),
          );
    try {
      // Accepted deferred writes count too; never bypass cookie policy via Web Storage.
      if (cookies.set(cookieName, encodeURIComponent(serialize(session)), maxAge)) {
        lastCookieWrite = now;
      }
    } catch {
      // Custom managers may throw; persistence must not interrupt telemetry.
    }
  }

  const store: SessionStore = {
    get() {
      if (!persist) return Promise.resolve(null);
      // The upstream store collapses malformed JSON and stored null into an absent key.
      let value: string | null = null;
      if (cookies) {
        try {
          value = cookies.get(cookieName) || null;
        } catch {
          return Promise.resolve(null);
        }
      }
      if (value === null) {
        if (ignoreBackup) return Promise.resolve(null);
        const result = storage?.getItem(storageKey);
        if (!result?.success || result.value === null) return Promise.resolve(null);
        value = result.value;
      } else {
        try {
          value = decodeURIComponent(value);
        } catch {
          // A present malformed cookie is authoritative; do not resurrect a storage backup.
          return Promise.resolve(null);
        }
      }
      let session: unknown;
      try {
        session = JSON.parse(value);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      if (
        typeof session === "object" &&
        session !== null &&
        "id" in session &&
        typeof session.id === "string" &&
        session.id.length > 0 &&
        "startTimestamp" in session &&
        typeof session.startTimestamp === "number" &&
        Number.isFinite(session.startTimestamp) &&
        session.startTimestamp >= 0 &&
        session.startTimestamp <= Date.now()
      ) {
        const lastActivity =
          "lastActivityTimestamp" in session
            ? session.lastActivityTimestamp
            : session.startTimestamp;
        if (
          typeof lastActivity === "number" &&
          Number.isFinite(lastActivity) &&
          lastActivity >= session.startTimestamp &&
          lastActivity <= Date.now()
        ) {
          lastActivityTimestamp = lastActivity;
          const restored = { id: session.id, startTimestamp: session.startTimestamp };
          if (expired(restored, Date.now())) return Promise.resolve(null);
          currentSession = restored;
          return Promise.resolve(restored);
        }
      }
      diag.warn("Invalid stored session; creating a new session.");
      return Promise.resolve(null);
    },
    save(session) {
      currentSession = session;
      lastActivityTimestamp = session.startTimestamp;
      save(session, true);
      return Promise.resolve();
    },
  };
  // Avoid upstream's five-second activity debounce.
  const createManager = () =>
    createSessionManager({
      sessionIdGenerator: createDefaultSessionIdGenerator(),
      sessionStore: store,
    });
  let manager = createManager();
  return {
    start: () => manager.start(),
    shutdown: () => manager.shutdown(),
    /** A missing user cookie must not resurrect the previous user's session backup. */
    discardBackup() {
      ignoreBackup = true;
      if (persist) storage?.removeItem(storageKey);
    },
    /** Saves the latest activity to the optional Web Storage backup without creating a session. */
    backup() {
      if (persist && currentSession) storage?.setItem(storageKey, serialize(currentSession));
    },
    getSessionId() {
      const session = manager.getSession();
      const now = Date.now();
      if (expired(session, now)) {
        manager.shutdown();
        manager = createManager();
        return manager.getSession().id;
      }
      if (now !== lastActivityTimestamp) {
        lastActivityTimestamp = now;
        save(session);
      } else if (cookies) {
        save(session);
      }
      return session.id;
    },
  };
}
