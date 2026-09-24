// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import {
  createDefaultSessionIdGenerator,
  createLocalStorageSessionStore,
  createSessionManager,
} from "@opentelemetry/browser-sdk/session";
import type { SessionStore } from "@opentelemetry/browser-sdk/session";

function createDefaultStore(): SessionStore {
  const store = createLocalStorageSessionStore();
  let unavailable = false;

  function useStorage<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
    if (unavailable) return Promise.resolve(fallback);
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
    return Promise.resolve(fallback);
  }

  return {
    async get() {
      const session: unknown = await useStorage(() => store.get(), null);
      if (session === null) return null;
      if (
        typeof session === "object" &&
        "id" in session &&
        typeof session.id === "string" &&
        session.id.length > 0 &&
        "startTimestamp" in session &&
        typeof session.startTimestamp === "number" &&
        Number.isFinite(session.startTimestamp) &&
        session.startTimestamp >= 0
      ) {
        return { id: session.id, startTimestamp: session.startTimestamp };
      }
      diag.warn("Invalid stored session; creating a new session.");
      return null;
    },
    save: (session) => useStorage(() => store.save(session), undefined),
  };
}

export function createSession() {
  return createSessionManager({
    inactivityTimeout: 30 * 60,
    sessionIdGenerator: createDefaultSessionIdGenerator(),
    sessionStore: createDefaultStore(),
  });
}
