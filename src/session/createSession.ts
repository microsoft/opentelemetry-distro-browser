// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import {
  createDefaultSessionIdGenerator,
  createSessionManager,
} from "@opentelemetry/browser-sdk/session";
import type { SessionStore } from "@opentelemetry/browser-sdk/session";

const storageKey = "opentelemetry-session";

function createDefaultStore(): SessionStore {
  let unavailable = false;

  function useStorage<T>(operation: () => T, fallback: T): T {
    if (unavailable) return fallback;
    try {
      if (typeof localStorage !== "undefined") return operation();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        (error.name !== "SecurityError" && error.name !== "QuotaExceededError")
      ) {
        throw error;
      }
    }
    unavailable = true;
    diag.warn("Session storage unavailable; using an in-memory session.");
    return fallback;
  }

  return {
    get() {
      // The upstream store collapses malformed JSON and stored null into an absent key.
      const stored = useStorage(() => localStorage.getItem(storageKey), null);
      if (stored === null) return Promise.resolve(null);
      let session: unknown;
      try {
        session = JSON.parse(stored);
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
        session.startTimestamp >= 0
      ) {
        return Promise.resolve({ id: session.id, startTimestamp: session.startTimestamp });
      }
      diag.warn("Invalid stored session; creating a new session.");
      return Promise.resolve(null);
    },
    save(session) {
      // The manager does not await saves; unexpected storage failures must throw synchronously.
      useStorage(() => localStorage.setItem(storageKey, JSON.stringify(session)), undefined);
      return Promise.resolve();
    },
  };
}

export function createSession() {
  return createSessionManager({
    inactivityTimeout: 30 * 60,
    sessionIdGenerator: createDefaultSessionIdGenerator(),
    sessionStore: createDefaultStore(),
  });
}
