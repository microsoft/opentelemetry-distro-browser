// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { defineBrowserCommand } from "@vitest/browser";
import type {} from "vitest/browser";
import type { Page, Frame } from "playwright";
import type { PageVisitNamespaceSnapshot } from "./pageVisitNamespaceFixture.js";
import { SDK_STATS_ENDPOINT } from "../fixtures/sdkStats.js";

interface NamespaceResult {
  documents: PageVisitNamespaceSnapshot[];
  frame?: {
    initial: PageVisitNamespaceSnapshot;
    navigated: PageVisitNamespaceSnapshot;
    reloaded: PageVisitNamespaceSnapshot;
    parentAfterStart: PageVisitNamespaceSnapshot;
    parentAfterNavigation: PageVisitNamespaceSnapshot;
    parentAfterReload: PageVisitNamespaceSnapshot;
    parentAfterShutdown: PageVisitNamespaceSnapshot;
  };
}

declare module "vitest/browser" {
  interface BrowserCommands {
    inspectPageVisitNamespaces(urls: string[], frameUrl?: string): Promise<NamespaceResult>;
  }
}

async function ready(target: Page | Frame): Promise<void> {
  await target.waitForFunction(() => document.body?.dataset.state, undefined, {
    timeout: 15_000,
  });
  const state = await target.evaluate(() => document.body.dataset.state);
  if (state !== "ready") throw new Error(`Page visit namespace fixture: ${state}`);
}

function snapshot(target: Page | Frame): Promise<PageVisitNamespaceSnapshot> {
  return target.evaluate(() => window.pageVisitNamespaceFixture.snapshot());
}

/** Source-backed real documents: no emitted artifacts or rebuild are needed for these regressions. */
export const inspectPageVisitNamespaces = defineBrowserCommand(
  async ({ page }, urls: string[], frameUrl?: string): Promise<NamespaceResult> => {
    const browser = page.context().browser();
    if (!browser) throw new Error("Namespace tests require a browser connection.");
    const fixtureContext = await browser.newContext();
    try {
      // Keep exporter/statistics traffic local; assertions inspect the custom processor directly.
      await fixtureContext.route(SDK_STATS_ENDPOINT, (route) =>
        route.fulfill({ status: 200, body: "{}" }),
      );
      await fixtureContext.route("**/page-visit-namespace-ingestion/**", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ itemsAccepted: 1, itemsReceived: 1, errors: [] }),
        }),
      );
      const fixturePage = await fixtureContext.newPage();
      const result: NamespaceResult = { documents: [] };
      for (const [index, url] of urls.entries()) {
        // Do not shut down between documents: pagehide must preserve the previous visit.
        await fixturePage.goto(url);
        await ready(fixturePage);
        result.documents.push(await snapshot(fixturePage));
        if (index !== 0 || !frameUrl) continue;

        await fixturePage.evaluate((src) => {
          const frame = document.createElement("iframe");
          frame.id = "visit-child";
          frame.src = src;
          document.body.appendChild(frame);
        }, frameUrl);
        await fixturePage
          .frameLocator("#visit-child")
          .locator("body[data-state]")
          .waitFor({ state: "attached", timeout: 10_000 });
        const child = fixturePage.frame({ url: frameUrl });
        if (!child) throw new Error("Same-origin child frame was not created.");
        await ready(child);
        const initial = await snapshot(child);
        const parentAfterStart = await snapshot(fixturePage);
        await child.evaluate(() => window.pageVisitNamespaceFixture.navigate());
        const navigated = await snapshot(child);
        const parentAfterNavigation = await snapshot(fixturePage);
        await child.goto(frameUrl);
        await ready(child);
        const reloaded = await snapshot(child);
        const parentAfterReload = await snapshot(fixturePage);
        await child.evaluate(() => window.pageVisitNamespaceFixture.shutdown());
        await fixturePage.locator("#visit-child").evaluate((frame) => frame.remove());
        result.frame = {
          initial,
          navigated,
          reloaded,
          parentAfterStart,
          parentAfterNavigation,
          parentAfterReload,
          parentAfterShutdown: await snapshot(fixturePage),
        };
      }
      return result;
    } finally {
      await fixtureContext.close();
    }
  },
);
