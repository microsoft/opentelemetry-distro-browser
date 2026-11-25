// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createDefaultSessionIdGenerator } from "@opentelemetry/browser-sdk/session";
import { isNonEmptyString } from "../shared/isNonEmptyString.js";
import type { CookieReadResult } from "../storage/cookieManager.js";
import type {
  MicrosoftOpenTelemetryBrowserCookieManager,
  MicrosoftOpenTelemetryBrowserUserContext,
} from "../types.js";
import type { UserContextProvider } from "./createUserContext.js";

function generateAnonymousId(): string {
  try {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    // Match the upstream fallback when Web Crypto is unavailable or restricted.
    return createDefaultSessionIdGenerator().generateSessionId();
  }
}

/**
 * Creates cookie-backed identity without accessing Web Storage during construction.
 * The caller supplies anonymous-cookie read permission from validated, snapshotted policy.
 * Cookie names are fully resolved by the caller. Optional legacy cleanup must honor Web Storage
 * permission and this instance's storage prefix:
 * clear retains stored anonymous identity; purge removes the whole record. Never restore it.
 */
export function createCookieUserContext(
  initialEnabled: boolean | undefined,
  cookies: MicrosoftOpenTelemetryBrowserCookieManager & {
    read?: (name: string) => CookieReadResult;
    isAccessEnabled?: () => boolean;
  },
  { user: anonymousCookie, authenticated: authenticatedCookie } = {
    user: "ai_user",
    authenticated: "ai_authUser",
  },
  onNewUser?: () => void,
  canReadAnonymousCookie = true,
  onLegacyCleanup?: (action: "clear" | "purge") => void,
  onEnabled?: () => void,
): {
  context: MicrosoftOpenTelemetryBrowserUserContext;
  provider: UserContextProvider;
  getSessionOwner(): string | null | undefined;
  shutdown(): void;
} {
  let enabled = initialEnabled !== false;
  let stopped = false;
  let anonymousValue = "";
  let anonymousIdentityEnabled = false;
  let anonymousOwner: string | undefined;
  let anonymousReadFailed = false;
  let newUserNotified = false;
  let authenticatedUserId: string | undefined;
  let accountId: string | undefined;
  let storeAuthentication = false;
  let removeAuthentication = false;

  function attempt(operation: () => boolean): boolean {
    try {
      return operation();
    } catch {
      return false;
    }
  }

  function purge(name: string): boolean {
    return attempt(() => cookies.purge(name));
  }

  function deleteAuthentication(): boolean {
    return attempt(() => cookies.del(authenticatedCookie));
  }

  function saveAnonymous(): void {
    if (stopped || !enabled) return;
    // Keep the accepted wire value so retries retain both the ID and acquisition date.
    anonymousValue ||= `${generateAnonymousId()}|${new Date(Date.now()).toISOString()}`;
    const accepted = attempt(() => cookies.set(anonymousCookie, anonymousValue, 31536000));
    // A custom write hook can synchronously disable or shut down this context.
    anonymousIdentityEnabled = accepted && enabled && !stopped;
    anonymousOwner = anonymousIdentityEnabled ? anonymousValue.split("|")[0] : undefined;
    // The hook may finish its write after the nested opt-out already purged the cookie.
    if (!enabled) purge(anonymousCookie);
  }

  function saveAuthentication(): void {
    if (stopped || !enabled) return;
    if (removeAuthentication) {
      removeAuthentication = !deleteAuthentication();
      return;
    }
    const userId = authenticatedUserId;
    if (!storeAuthentication || userId === undefined) return;
    const accepted = attempt(() => {
      // AI's decoded pipe delimiter cannot represent pipes within either identity field.
      if (userId.includes("|") || accountId?.includes("|")) return false;
      return cookies.set(
        authenticatedCookie,
        encodeURI(userId + (accountId === undefined ? "" : `|${accountId}`)),
      );
    });
    if (!enabled) {
      purge(authenticatedCookie);
    } else if (!accepted) {
      // Do not leave a previous login available for restoration after a failed replacement.
      if (!stopped) deleteAuthentication();
    }
  }

  function restoreAnonymous(value: string): void {
    if (!enabled || stopped) return;
    const parts = value.split("|");
    const id = parts.length === 2 ? parts[0] : undefined;
    const acquired = Date.parse(parts[1] ?? "");
    if (isNonEmptyString(id) && Number.isFinite(acquired) && acquired >= 0) {
      anonymousValue = value;
      anonymousIdentityEnabled = true;
      anonymousOwner = id;
    } else {
      if (
        canReadAnonymousCookie &&
        !newUserNotified &&
        onNewUser &&
        attempt(() => cookies.isEnabled())
      ) {
        newUserNotified = true;
        attempt(() => {
          onNewUser();
          return true;
        });
      }
      saveAnonymous();
    }
  }

  function readAnonymous(): CookieReadResult {
    // A disabled manager's pending-value read is not recovery from a failed browser read.
    if (anonymousReadFailed && cookies.isAccessEnabled?.() === false) return { success: false };
    try {
      const result = cookies.read
        ? cookies.read(anonymousCookie)
        : { success: true as const, value: cookies.get(anonymousCookie) };
      anonymousReadFailed = !result.success;
      return result;
    } catch {
      anonymousReadFailed = true;
      return { success: false };
    }
  }

  function refreshAnonymous(result = readAnonymous()): void {
    // An unavailable read is not evidence of a new user. Leave identity unresolved so a
    // later enable or enrichment can retry without replacing cookies or discarding backups.
    if (result.success) restoreAnonymous(result.value);
    else {
      anonymousOwner = undefined;
      anonymousIdentityEnabled = false;
    }
  }

  if (enabled) {
    try {
      const anonymous = readAnonymous();
      const authenticatedValue = cookies.get(authenticatedCookie);
      refreshAnonymous(anonymous);

      if (authenticatedValue) {
        let parts: string[] = [];
        try {
          parts = decodeURI(authenticatedValue).split("|");
        } catch {
          // A malformed URI follows the same cleanup path as an invalid identity.
        }
        const [user, account] = parts;
        if (
          parts.length <= 2 &&
          isNonEmptyString(user) &&
          (account === undefined || isNonEmptyString(account))
        ) {
          authenticatedUserId = user;
          accountId = account;
          storeAuthentication = true;
        } else {
          deleteAuthentication();
        }
      }
    } catch {
      // A custom manager may throw, unlike the built-in manager. Initialization stays safe.
      anonymousIdentityEnabled = false;
    }
  }

  const context: MicrosoftOpenTelemetryBrowserUserContext = {
    setAuthenticatedUserContext(userId, newAccountId, storeInCookie = false) {
      if (!isNonEmptyString(userId)) {
        throw new TypeError("Authenticated user ID must be a non-empty string.");
      }
      if (newAccountId !== undefined && !isNonEmptyString(newAccountId)) {
        throw new TypeError("Account ID must be a non-empty string when provided.");
      }
      authenticatedUserId = userId;
      accountId = newAccountId;
      storeAuthentication = storeInCookie === true;
      // A memory-only login supersedes any saved login, even when persistence is disabled.
      removeAuthentication = !storeAuthentication;
      saveAuthentication();
    },
    clearAuthenticatedUserContext() {
      authenticatedUserId = undefined;
      accountId = undefined;
      storeAuthentication = false;
      removeAuthentication = false;
      // del, rather than purge, honors the cookie manager's deferred-cleanup policy.
      deleteAuthentication();
      attempt(() => {
        onLegacyCleanup?.("clear");
        return true;
      });
    },
    setEnabled(newEnabled) {
      if (stopped && newEnabled) return;
      enabled = newEnabled;
      anonymousOwner = undefined;
      if (enabled) {
        try {
          refreshAnonymous();
        } catch {
          anonymousIdentityEnabled = false;
        }
        onEnabled?.();
        saveAuthentication();
      } else {
        anonymousIdentityEnabled = false;
        // Purge also cancels deferred writes, even when the physical deletion fails.
        purge(anonymousCookie);
        if (purge(authenticatedCookie)) removeAuthentication = false;
        attempt(() => {
          onLegacyCleanup?.("purge");
          return true;
        });
      }
    },
  };

  return {
    context,
    // Cached state and policy only, including during shutdown backup. Revoking cookie access
    // must not turn a failed permitted identity read into permission to reuse a backup.
    getSessionOwner: () =>
      !enabled || !canReadAnonymousCookie
        ? null
        : (anonymousOwner ??
          (!anonymousReadFailed && cookies.isAccessEnabled?.() === false ? null : undefined)),
    provider: {
      getAnonymousUserId() {
        if (stopped) return undefined;
        if (enabled && !anonymousIdentityEnabled && attempt(() => cookies.isEnabled())) {
          try {
            // Recover after runtime cookie enablement without replaying authentication.
            refreshAnonymous();
          } catch {
            // Custom cookie managers may throw while reading.
          }
        }
        return enabled && !stopped && anonymousIdentityEnabled
          ? anonymousValue.split("|")[0]
          : undefined;
      },
      getAuthenticatedUserId: () => authenticatedUserId,
      getAccountId: () => accountId,
    },
    shutdown() {
      stopped = true;
      anonymousIdentityEnabled = false;
    },
  };
}
