// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { context, diag, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, vi } from "vitest";
import type { FrameworkPlugin } from "../../src/frameworks/telemetry.js";
import type { MicrosoftOpenTelemetryBrowserOptions } from "../../src/index.js";
import { createInMemoryPipeline } from "./telemetry.js";

const cleanups: (() => void | Promise<void>)[] = [];

/** Load the actual package artifacts without requiring them to exist during test discovery. */
export async function loadFrameworks() {
  const coreUrl = new URL("../../dist/esm/index.js", import.meta.url).href;
  const reactUrl = new URL("../../dist/esm/react.js", import.meta.url).href;
  const [core, react] = await Promise.all([
    import(/* @vite-ignore */ coreUrl) as Promise<typeof import("../../src/index.js")>,
    import(/* @vite-ignore */ reactUrl) as Promise<
      typeof import("../../src/frameworks/react/index.js")
    >,
  ]);
  return { core, react };
}

export async function startFrameworkTelemetry(
  plugin: FrameworkPlugin & { pageView?: MicrosoftOpenTelemetryBrowserOptions["pageView"] },
  pageView = plugin.pageView ?? { enabled: false },
  options: Omit<MicrosoftOpenTelemetryBrowserOptions, "pageView"> = {},
) {
  const { core } = await loadFrameworks();
  const pipeline = createInMemoryPipeline();
  const telemetry = await core.useMicrosoftOpenTelemetry({
    ...pipeline.options,
    instrumentations: [plugin],
    pageView: { softNavigationSettleTimeoutMs: 50, ...pageView },
    session: { enabled: false },
    userContext: { enabled: false },
    storage: { enabled: false },
    ...options,
  });
  cleanups.push(() => telemetry.shutdown());
  const records = () => pipeline.logExporter.getFinishedLogRecords();
  const pages = () => records().filter((record) => record.eventName === "browser.page_view");
  return {
    ...pipeline,
    telemetry,
    records,
    pages,
    async waitForPages(count: number) {
      await expect
        .poll(async () => {
          await telemetry.forceFlush();
          return pages().length;
        })
        .toBe(count);
      return pages();
    },
  };
}

export function mountReact(children: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host, { onCaughtError: () => {} });
  let mounted = true;
  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    flushSync(() => root.unmount());
    host.remove();
  };
  cleanups.push(unmount);
  const render = (node: ReactNode) => flushSync(() => root.render(node));
  render(children);
  return { host, render, unmount };
}

/** Unmount consumers and stop SDKs before clearing their shared OpenTelemetry registrations. */
export async function cleanupFrameworks(): Promise<void> {
  const failures: unknown[] = [];
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    trace.disable();
    logs.disable();
    context.disable();
    propagation.disable();
    diag.disable();
    vi.restoreAllMocks();
  }
  if (failures.length) throw new AggregateError(failures, "Framework fixture cleanup failed");
}
