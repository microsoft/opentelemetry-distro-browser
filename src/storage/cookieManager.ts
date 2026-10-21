// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { diag } from "@opentelemetry/api";
import type {
  MicrosoftOpenTelemetryBrowserCookieConfig,
  MicrosoftOpenTelemetryBrowserCookieManager,
} from "../types.js";

/**
 * Creates an instance-owned cookie manager without accessing cookies during construction.
 * Settings (including inherited/non-enumerable members and lists) are snapshotted.
 * Unlike AI JS, values cannot contain attribute suffixes: raw semicolons and control
 * characters are rejected to prevent cookie-header injection. Encode such values first.
 * Disabled writes/deletes are deferred by default; this is not a consent buffer for telemetry.
 */
export function createCookieManager(
  config?: MicrosoftOpenTelemetryBrowserCookieConfig,
): MicrosoftOpenTelemetryBrowserCookieManager & { shutdown(): void } {
  if (
    config !== undefined &&
    (config === null || typeof config !== "object" || Array.isArray(config))
  ) {
    throw new TypeError("cookieCfg must be a non-null, non-array object.");
  }
  const settings = {
    enabled: config?.enabled,
    domain: config?.domain,
    path: config?.path,
    ignoreCookies: config?.ignoreCookies,
    blockedCookies: config?.blockedCookies,
    disableCookieDefer: config?.disableCookieDefer,
    getCookie: config?.getCookie,
    setCookie: config?.setCookie,
    delCookie: config?.delCookie,
  };
  for (const key of ["enabled", "disableCookieDefer"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "boolean") {
      throw new TypeError(`cookieCfg.${key} must be a boolean.`);
    }
  }
  for (const key of ["domain", "path"] as const) {
    const value = settings[key];
    if (value !== undefined && (typeof value !== "string" || !safeAttribute(value))) {
      throw new TypeError(`cookieCfg.${key} must be a safe cookie attribute string.`);
    }
  }
  for (const key of ["ignoreCookies", "blockedCookies"] as const) {
    const value = settings[key];
    if (
      value !== undefined &&
      (!Array.isArray(value) || Array.from(value).some((name) => typeof name !== "string"))
    ) {
      throw new TypeError(`cookieCfg.${key} must be an array of strings.`);
    }
  }
  for (const key of ["getCookie", "setCookie", "delCookie"] as const) {
    if (settings[key] !== undefined && typeof settings[key] !== "function") {
      throw new TypeError(`cookieCfg.${key} must be a function.`);
    }
  }

  const ignored = new Set(settings.ignoreCookies);
  const blocked = new Set(settings.blockedCookies);
  const pending = new Map<string, { value: string; formatted: string; remove: boolean }>();
  let enabled = settings.enabled !== false;
  let everEnabled = enabled;
  let stopped = false;

  function attempt<T>(operation: () => T, fallback: T): T {
    try {
      return operation();
    } catch {
      // Hooks and browser privacy restrictions must never interrupt telemetry. Do not log values.
      try {
        diag.warn("Cookie operation failed or cookies are unavailable.");
      } catch {
        // A consumer-provided diagnostic logger must not turn persistence into a failure.
      }
      return fallback;
    }
  }

  function write(name: string, formatted: string, remove: boolean): boolean {
    return attempt(() => {
      const hook = remove ? settings.delCookie : settings.setCookie;
      if (hook) hook(name, formatted);
      else document.cookie = `${name}=${formatted}`;
      return true;
    }, false);
  }

  function attributes(domain: string | undefined, path: string): string {
    return `${domain ? `; domain=${domain}` : ""}; path=${path}`;
  }

  function deletion(path?: string): string {
    const secure = typeof location !== "undefined" && location.protocol === "https:";
    return `; expires=Thu, 01 Jan 1970 00:00:01 GMT; max-age=0${secure ? "; secure" : ""}${attributes(settings.domain, path || settings.path || "/")}`;
  }

  function validPrefixScope(name: string, path?: string, domain?: string): boolean {
    return (
      !name.startsWith("__Host-") ||
      (!(domain || settings.domain) && (path || settings.path || "/") === "/")
    );
  }

  function validScope(name: string, path?: string, domain?: string): boolean {
    return (
      typeof name === "string" &&
      /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) &&
      (path === undefined || (typeof path === "string" && safeAttribute(path))) &&
      (domain === undefined || (typeof domain === "string" && safeAttribute(domain)))
    );
  }

  function store(name: string, value: string, formatted: string, remove: boolean): boolean {
    if (enabled) return write(name, formatted, remove);
    if (settings.disableCookieDefer) return false;
    // Delete before re-inserting so flush order also reflects the latest operation per name.
    pending.delete(name);
    pending.set(name, { value, formatted, remove });
    return true;
  }

  return {
    isEnabled: () =>
      enabled &&
      !stopped &&
      attempt(
        () =>
          !!(settings.getCookie || settings.setCookie || settings.delCookie) ||
          typeof document.cookie === "string",
        false,
      ),
    setEnabled(value) {
      if (stopped || typeof value !== "boolean") return;
      enabled = value;
      everEnabled ||= value;
      if (enabled) {
        const operations = Array.from(pending);
        pending.clear();
        for (const [name, operation] of operations) {
          if (stopped || !enabled) break;
          write(name, operation.formatted, operation.remove);
        }
      }
    },
    get(name) {
      if (stopped || !validScope(name) || ignored.has(name)) return "";
      if (!enabled) return pending.get(name)?.value ?? "";
      return attempt(() => {
        if (settings.getCookie) {
          const value = settings.getCookie(name);
          return typeof value === "string" ? value : "";
        }
        for (const part of document.cookie.split(";")) {
          const cookie = part.trim();
          const separator = cookie.indexOf("=");
          if (cookie.slice(0, separator) === name) return cookie.slice(separator + 1);
        }
        return "";
      }, "");
    },
    set(name, value, maxAgeSec, domain, path) {
      if (
        stopped ||
        !validScope(name, path, domain) ||
        !validPrefixScope(name, path, domain) ||
        typeof value !== "string" ||
        !safeAttribute(value) ||
        ignored.has(name) ||
        blocked.has(name) ||
        (maxAgeSec !== undefined && (typeof maxAgeSec !== "number" || !Number.isFinite(maxAgeSec)))
      ) {
        return false;
      }
      return attempt(() => {
        let formatted = value.trim();
        if (maxAgeSec !== undefined) {
          const expiry = new Date(Date.now() + maxAgeSec * 1000);
          if (!Number.isFinite(expiry.getTime())) return false;
          formatted += `; expires=${expiry.toUTCString()}; max-age=${Math.floor(maxAgeSec)}`;
        }
        if (typeof location !== "undefined" && location.protocol === "https:") {
          formatted += "; secure; SameSite=None";
        }
        formatted += attributes(domain || settings.domain, path || settings.path || "/");
        return store(name, value.trim(), formatted, false);
      }, false);
    },
    del(name, path) {
      if (stopped && !everEnabled) return false;
      if (!validScope(name, path) || !validPrefixScope(name, path)) return false;
      // Shutdown discards deferred operations, but explicit cleanup must remain available.
      if (stopped) return write(name, deletion(path), true);
      return store(name, "", deletion(path), true);
    },
    purge(name, path) {
      // Cleanup bypasses enabled, ignored/blocked lists and shutdown, and cannot resurrect a write.
      pending.delete(name);
      if (!validScope(name, path) || !validPrefixScope(name, path)) return false;
      return write(name, deletion(path), true);
    },
    shutdown() {
      stopped = true;
      enabled = false;
      pending.clear();
    },
  };
}

function safeAttribute(value: string): boolean {
  // Intentionally reject cookie-header control characters, not just line breaks.
  // eslint-disable-next-line no-control-regex
  return !/[;\x00-\x1f\x7f]/.test(value);
}
