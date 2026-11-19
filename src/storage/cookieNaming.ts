// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { MicrosoftOpenTelemetryBrowserOptions } from "../types.js";

/** Resolves startup-only AI suffixes without changing the existing distro prefix contract. */
export function resolveCookieNames(
  options: Pick<
    MicrosoftOpenTelemetryBrowserOptions,
    "namePrefix" | "userCookiePostfix" | "sessionCookiePostfix"
  >,
  storagePrefix = "",
) {
  const { namePrefix = "", userCookiePostfix = "", sessionCookiePostfix = "" } = options;
  for (const [name, value] of Object.entries({
    namePrefix,
    userCookiePostfix,
    sessionCookiePostfix,
    "storage.namePrefix": storagePrefix,
  })) {
    if (typeof value !== "string" || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]*$/.test(value)) {
      throw new TypeError(`${name} must contain only cookie-name token characters.`);
    }
  }
  if (storagePrefix && (namePrefix || userCookiePostfix || sessionCookiePostfix)) {
    throw new TypeError("AI cookie naming cannot be combined with storage.namePrefix.");
  }
  const sessionSuffix = sessionCookiePostfix || namePrefix;
  return {
    user: `${storagePrefix}ai_user${userCookiePostfix}`,
    authenticated: `${storagePrefix}ai_authUser`,
    session: `${storagePrefix}ai_session${sessionSuffix}`,
    // ':' is not a valid naming token, keeping suffix and legacy-prefix namespaces disjoint.
    // Keep distro JSON separate from AI's pipe-delimited ai_session backup.
    sessionBackup: sessionSuffix
      ? `opentelemetry-session:${sessionSuffix}`
      : "opentelemetry-session",
  };
}
