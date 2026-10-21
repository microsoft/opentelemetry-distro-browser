// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createDefaultSessionIdGenerator } from "@opentelemetry/browser-sdk/session";
import { isNonEmptyString } from "../shared/isNonEmptyString.js";
import type {
  MicrosoftOpenTelemetryBrowserCookieManager,
  MicrosoftOpenTelemetryBrowserUserContext,
} from "../types.js";
import type { UserContextProvider } from "./createUserContext.js";

interface AnonymousIdentity {
  anonymousId: string;
  acquisitionTimestamp: number;
}

function generateAnonymousId(): string {
  try {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    // Match the upstream fallback when Web Crypto is unavailable or restricted.
    return createDefaultSessionIdGenerator().generateSessionId();
  }
}

/** Decode only JSON records; callers select validated own fields rather than copying input. */
function decode(value: string): object | undefined {
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    // Malformed URI/JSON and identity values must not escape into diagnostics.
    return undefined;
  }
}

function own(value: object | undefined, key: string): unknown {
  return value && Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Creates cookie-backed identity without reading or writing Web Storage. */
export function createCookieUserContext(
  initialEnabled: boolean | undefined,
  cookies: MicrosoftOpenTelemetryBrowserCookieManager,
  namePrefix = "",
  onNewUser?: () => void,
): {
  context: MicrosoftOpenTelemetryBrowserUserContext;
  provider: UserContextProvider;
} {
  const anonymousCookie = `${namePrefix}opentelemetry-user`;
  const authenticatedCookie = `${namePrefix}opentelemetry-auth-user`;
  let enabled = initialEnabled !== false;
  let anonymousIdentity: AnonymousIdentity | undefined;
  let anonymousIdentityEnabled = false;
  let newUserNotified = false;
  let authenticatedUserId: string | undefined;
  let accountId: string | undefined;
  let storeAuthentication = false;

  function attempt(operation: () => boolean): boolean {
    try {
      return operation();
    } catch {
      return false;
    }
  }

  function saveAnonymous(): void {
    anonymousIdentity ??= {
      anonymousId: generateAnonymousId(),
      acquisitionTimestamp: Date.now(),
    };
    anonymousIdentityEnabled = attempt(() =>
      cookies.set(anonymousCookie, encodeURIComponent(JSON.stringify(anonymousIdentity)), 31536000),
    );
  }

  function saveAuthentication(): void {
    if (!enabled || !storeAuthentication || authenticatedUserId === undefined) return;
    if (
      !attempt(() =>
        cookies.set(
          authenticatedCookie,
          encodeURIComponent(JSON.stringify({ authenticatedUserId, accountId })),
        ),
      )
    ) {
      // Do not leave a previous login available for restoration after a failed replacement.
      attempt(() => cookies.del(authenticatedCookie));
    }
  }

  function restoreAnonymous(value: string): void {
    const anonymous = decode(value);
    const id = own(anonymous, "anonymousId");
    const acquired = own(anonymous, "acquisitionTimestamp");
    if (
      isNonEmptyString(id) &&
      typeof acquired === "number" &&
      Number.isFinite(acquired) &&
      acquired >= 0
    ) {
      anonymousIdentity = { anonymousId: id, acquisitionTimestamp: acquired };
      anonymousIdentityEnabled = true;
    } else {
      if (enabled && !newUserNotified && onNewUser && attempt(() => cookies.isEnabled())) {
        newUserNotified = true;
        attempt(() => {
          onNewUser();
          return true;
        });
      }
      saveAnonymous();
    }
  }

  if (enabled) {
    try {
      const anonymousValue = cookies.get(anonymousCookie);
      const authenticatedValue = cookies.get(authenticatedCookie);
      restoreAnonymous(anonymousValue);

      const authenticated = decode(authenticatedValue);
      const user = own(authenticated, "authenticatedUserId");
      const account = own(authenticated, "accountId");
      if (isNonEmptyString(user) && (account === undefined || isNonEmptyString(account))) {
        authenticatedUserId = user;
        accountId = account;
        storeAuthentication = true;
      } else if (authenticatedValue) {
        attempt(() => cookies.del(authenticatedCookie));
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
      if (!enabled) return;
      if (storeAuthentication) saveAuthentication();
      else attempt(() => cookies.del(authenticatedCookie));
    },
    clearAuthenticatedUserContext() {
      authenticatedUserId = undefined;
      accountId = undefined;
      storeAuthentication = false;
      // del, rather than purge, honors the cookie manager's deferred-cleanup policy.
      attempt(() => cookies.del(authenticatedCookie));
    },
    setEnabled(newEnabled) {
      enabled = newEnabled;
      if (enabled) {
        try {
          restoreAnonymous(cookies.get(anonymousCookie));
        } catch {
          anonymousIdentityEnabled = false;
        }
        saveAuthentication();
      } else {
        anonymousIdentityEnabled = false;
        // Purge also cancels deferred writes, even when the physical deletion fails.
        attempt(() => cookies.purge(anonymousCookie));
        attempt(() => cookies.purge(authenticatedCookie));
      }
    },
  };

  return {
    context,
    provider: {
      getAnonymousUserId() {
        if (enabled && !anonymousIdentityEnabled && attempt(() => cookies.isEnabled())) {
          try {
            // Recover after runtime cookie enablement without replaying authentication.
            restoreAnonymous(cookies.get(anonymousCookie));
          } catch {
            // Custom cookie managers may throw while reading.
          }
        }
        return anonymousIdentityEnabled ? anonymousIdentity?.anonymousId : undefined;
      },
      getAuthenticatedUserId: () => authenticatedUserId,
      getAccountId: () => accountId,
    },
  };
}
