// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import {
  createDefaultSessionIdGenerator,
  createSessionManager,
} from "@opentelemetry/browser-sdk/session";
import type { Session, SessionStore } from "@opentelemetry/browser-sdk/session";
import type { CookieReadResult } from "../storage/cookieManager.js";
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
  cookies?: MicrosoftOpenTelemetryBrowserCookieManager & {
    read?: (name: string) => CookieReadResult;
    cancelPending?: (name: string, value: string) => void;
    removeIfValue?: (name: string, value: string) => boolean;
  },
  cookieName = "ai_session",
  readLifetimes?: () => { readonly inactivityTimeout: number; readonly maxDuration: number },
  backupKey = storageKey,
  // Null opts out of owner validation; undefined defers it until identity-read recovery.
  readOwner: () => string | null | undefined = () => null,
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
  let lastCookiePolicy: { inactivityTimeout: number; maxDuration: number } | undefined;
  let ignoreBackup = false;
  let readFailed = false;
  let restoredFromBackup = false;
  let sessionOwner: string | null | undefined;
  let lastCookieValue: string | undefined;
  let rejectedCookieValue: string | undefined;
  let cookieWrites = 0;

  function removeRejectedCookie(): void {
    if (rejectedCookieValue === undefined || cookieWrites > 0) return;
    try {
      if (cookies?.removeIfValue?.(cookieName, rejectedCookieValue)) {
        rejectedCookieValue = undefined;
      }
    } catch {
      // Keep the exact rejected value for a bounded retry on later activity or backup.
    }
  }

  function expired(session: Session, now: number): boolean {
    const policy = readLifetimes?.() ?? { inactivityTimeout, maxDuration };
    return (
      now < session.startTimestamp ||
      now < lastActivityTimestamp ||
      (policy.inactivityTimeout > 0 &&
        (now - lastActivityTimestamp) / 1000 >= policy.inactivityTimeout) ||
      (policy.maxDuration > 0 && (now - session.startTimestamp) / 1000 >= policy.maxDuration)
    );
  }

  function serialize(session: Session): string {
    return JSON.stringify({
      ...session,
      lastActivityTimestamp,
      ...(readOwner() !== null && typeof sessionOwner === "string"
        ? { anonymousId: sessionOwner }
        : {}),
    });
  }

  function save(session: Session, force = false): void {
    // Keep errors synchronous because upstream does not await saves.
    if (!persist || readFailed) return;
    // A failed identity opt-in must not promote an unvalidated backup to an authoritative cookie.
    if (restoredFromBackup && readOwner() === undefined) return;
    if (!cookies) {
      storage?.setItem(backupKey, serialize(session));
      return;
    }
    const now = Date.now();
    const policy = readLifetimes?.() ?? { inactivityTimeout, maxDuration };
    if (
      !force &&
      lastCookieWrite !== undefined &&
      lastCookiePolicy?.inactivityTimeout === policy.inactivityTimeout &&
      lastCookiePolicy.maxDuration === policy.maxDuration &&
      now >= lastCookieWrite &&
      (now === lastCookieWrite ||
        ((policy.inactivityTimeout === 0 || policy.inactivityTimeout > 60) &&
          now - lastCookieWrite < 60_000))
    ) {
      return;
    }
    // Short inactivity windows need each activity persisted to survive reloads.
    // A rejected renewal must not inherit the previous session's accepted-write throttle.
    lastCookieWrite = undefined;
    // Round cookie retention up to whole seconds; timestamps enforce the exact session deadline.
    const maxAge =
      policy.maxDuration === 0
        ? undefined
        : Math.ceil(
            Math.max(
              0,
              Math.min(
                policy.maxDuration - (now - session.startTimestamp) / 1000,
                policy.inactivityTimeout > 0
                  ? policy.inactivityTimeout - (now - lastActivityTimestamp) / 1000
                  : Infinity,
              ),
            ),
          );
    try {
      // Accepted deferred writes count too; never bypass cookie policy via Web Storage.
      // Legacy JSON IDs may not be safe in AI's raw pipe-delimited cookie format.
      // eslint-disable-next-line no-control-regex
      if (/[;|\x00-\x1f\x7f]/.test(session.id)) return;
      const value = `${session.id}|${session.startTimestamp}|${lastActivityTimestamp}`;
      const previousValue = lastCookieValue;
      // A hook can change identity before completing its write. Track it before calling out.
      lastCookieValue = value;
      cookieWrites++;
      let accepted: boolean;
      try {
        accepted = cookies.set(cookieName, value, maxAge);
      } finally {
        cookieWrites--;
      }
      if (rejectedCookieValue === value) {
        // A nested hook may already have selected and written a newer authoritative session.
        // Its write must win if the outer hook completed the rejected renewal afterward.
        if (currentSession && currentSession !== session) save(currentSession, true);
        return;
      }
      if (accepted) {
        lastCookieWrite = now;
        lastCookiePolicy = { ...policy };
      } else if (lastCookieValue === value) {
        lastCookieValue = previousValue;
      }
    } catch {
      // Custom managers may throw; persistence must not interrupt telemetry.
    } finally {
      removeRejectedCookie();
    }
  }

  function restore(): Session | null {
    if (!persist) return null;
    // The upstream store collapses malformed JSON and stored null into an absent key.
    let value: string | null = null;
    if (cookies) {
      try {
        const result = cookies.read
          ? cookies.read(cookieName)
          : { success: true as const, value: cookies.get(cookieName) };
        readFailed = !result.success;
        if (!result.success) return null;
        value = result.value || null;
        // Reject our own invalidated backup renewal, without deleting a newer cookie.
        if (value !== null && value === rejectedCookieValue) return null;
      } catch {
        readFailed = true;
        return null;
      }
    }
    const fromBackup = value === null;
    let id: unknown;
    let startTimestamp: unknown;
    let lastActivity: unknown;
    let backupOwner: unknown;
    if (value === null) {
      if (ignoreBackup) return null;
      const result = storage?.getItem(backupKey);
      if (!result?.success || result.value === null) return null;
      try {
        const session: unknown = JSON.parse(result.value);
        if (typeof session === "object" && session !== null) {
          backupOwner = Object.hasOwn(session, "anonymousId")
            ? (session as { anonymousId: unknown }).anonymousId
            : undefined;
          id = "id" in session ? session.id : undefined;
          startTimestamp = "startTimestamp" in session ? session.startTimestamp : undefined;
          lastActivity =
            "lastActivityTimestamp" in session ? session.lastActivityTimestamp : startTimestamp;
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    } else {
      const parts = value.split("|");
      // A present malformed cookie is authoritative; do not resurrect a storage backup.
      if (parts.length !== 3) return null;
      id = parts[0];
      startTimestamp = parts[1] ? Number(parts[1]) : undefined;
      lastActivity = parts[2] ? Number(parts[2]) : undefined;
    }
    if (
      typeof id === "string" &&
      id.length > 0 &&
      typeof startTimestamp === "number" &&
      Number.isFinite(startTimestamp) &&
      startTimestamp >= 0 &&
      startTimestamp <= Date.now() &&
      typeof lastActivity === "number" &&
      Number.isFinite(lastActivity) &&
      lastActivity >= startTimestamp &&
      lastActivity <= Date.now()
    ) {
      lastActivityTimestamp = lastActivity;
      const restored = { id, startTimestamp };
      if (expired(restored, Date.now())) return null;
      const owner = readOwner();
      if (fromBackup) {
        // A shared user cookie may have been recreated by another app, whose new-user cleanup
        // cannot clear this suffix's backup. Unresolved reads are not evidence of a mismatch.
        if (owner === undefined) {
          readFailed = true;
          return null;
        }
        if (typeof owner === "string" && owner !== backupOwner) return null;
      }
      sessionOwner =
        fromBackup && owner === null && typeof backupOwner === "string" ? backupOwner : owner;
      currentSession = restored;
      restoredFromBackup = fromBackup;
      return restored;
    }
    diag.warn("Invalid stored session; creating a new session.");
    return null;
  }

  const store: SessionStore = {
    get() {
      return Promise.resolve(restore());
    },
    save(session) {
      // Keep a provisional session for correlation during read failures, without persisting
      // over unresolved cookies or backups. Later enrichment retries authoritative restoration.
      currentSession = session;
      restoredFromBackup = false;
      sessionOwner = readOwner();
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
  function discardRestoredSession(): void {
    if (!restoredFromBackup) return;
    rejectedCookieValue = lastCookieValue ?? rejectedCookieValue;
    if (lastCookieValue !== undefined) {
      try {
        cookies?.cancelPending?.(cookieName, lastCookieValue);
        // A completed replay is no longer pending. Remove its exact stale value only; never
        // delete a current cookie merely because its name matches this session's cookie name.
        // Keep the rejection until after a possibly re-entrant replay finishes. Its post-write
        // cleanup can fail after this pre-write check succeeds; backup/activity must retry it.
        if (cookieWrites === 0) cookies?.removeIfValue?.(cookieName, lastCookieValue);
      } catch {
        // Custom cookie managers must not interrupt identity controls.
      }
    }
    lastCookieValue = undefined;
    lastCookieWrite = undefined;
    currentSession = undefined;
    restoredFromBackup = false;
    // The next session read restores the current authoritative cookie, not this backup.
    readFailed = true;
    manager.shutdown();
    manager = createManager();
  }
  function refreshOwner(): void {
    const owner = readOwner();
    if (restoredFromBackup && owner === undefined && lastCookieValue !== undefined) {
      // An earlier identity-disabled activity may already have renewed this backup. Suspend
      // that exact renewal too, so reload cannot treat it as an owner-validated cookie.
      rejectedCookieValue = lastCookieValue;
      try {
        cookies?.cancelPending?.(cookieName, lastCookieValue);
      } catch {
        // Keep the rejection for a later conditional cleanup if a custom manager fails.
      }
      lastCookieValue = undefined;
      lastCookieWrite = undefined;
      removeRejectedCookie();
    }
    if (restoredFromBackup && typeof owner === "string" && owner !== sessionOwner) {
      ignoreBackup = true;
      discardRestoredSession();
    }
    // Bind previously identity-disabled sessions, but never relabel an already known owner.
    if (sessionOwner == null) sessionOwner = owner;
  }
  return {
    start: () => manager.start(),
    shutdown: () => manager.shutdown(),
    refreshOwner,
    /** Explicit identity opt-out forgets ownership even when Web Storage is disabled. */
    clearOwner() {
      sessionOwner = undefined;
    },
    /** A missing user cookie must not resurrect the previous user's session backup. */
    discardBackup() {
      ignoreBackup = true;
      discardRestoredSession();
      if (persist) storage?.removeItem(backupKey);
    },
    /** Saves the latest activity to the optional Web Storage backup without creating a session. */
    backup() {
      refreshOwner();
      removeRejectedCookie();
      if (persist && !readFailed && currentSession && readOwner() !== undefined) {
        storage?.setItem(backupKey, serialize(currentSession));
      }
    },
    getSessionId() {
      refreshOwner();
      removeRejectedCookie();
      if (readFailed) {
        const restored = restore();
        if (!readFailed) {
          currentSession = restored ?? undefined;
          lastCookieWrite = undefined;
          manager.shutdown();
          manager = createManager();
        }
      }
      const session = currentSession ?? manager.getSession();
      const now = Date.now();
      if (expired(session, now)) {
        currentSession = undefined;
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
