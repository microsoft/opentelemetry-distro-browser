import { expect, test } from "@playwright/test";

test("isolates application and upstream instrumentation spans across SDK instances", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-status]")).toHaveText("PASS");

    const result = await page.evaluate(() => window.pocResult);
    expect(result?.checks).toEqual({
        alphaIsolated: true,
        betaIsolated: true,
        alphaAsyncParent: true,
        betaAsyncParent: true,
        upstreamInstrumentationRouted: true,
        upstreamInstrumentationParentage: true
    });
});