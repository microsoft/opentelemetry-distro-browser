import { expect, test } from "@playwright/test";

test("isolates spans, events, lifecycle and context across SDK instances", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-status]")).toHaveText("PASS", { timeout: 20000 });

    const result = await page.evaluate(() => window.pocResult);
    expect(result?.checks).toEqual({
        alphaIsolated: true,
        betaIsolated: true,
        alphaAsyncParent: true,
        betaAsyncParent: true,
        upstreamInstrumentationRouted: true,
        upstreamInstrumentationParentage: true,
        isolatedInstrumentationsRunInEveryInstance: true,
        sharedPatchInstrumentationsHaveSingleOwner: true,
        sharedPatchDuplicatesWithoutArbitration: true,
        alphaEventsIsolated: true,
        betaEventsIsolated: true,
        eventsUseTopLevelEventName: true,
        browserContextOnBothSignals: true,
        w3cTraceContextRoundTrip: true,
        baggageRoundTrip: true,
        forceFlushControlsExport: true,
        staleTracerAndLoggerAreInert: true,
        shutdownIsIdempotent: true,
        globalOwnershipConflictReported: true
    });
});

test("every bundled instrumentation produces signal", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-status]")).toHaveText("PASS", { timeout: 20000 });

    const result = await page.evaluate(() => window.pocResult);
    const observations = result?.instrumentations ?? [];
    expect(observations).toHaveLength(9);

    for (const observation of observations) {
        // The owning instance must see every instrumentation, otherwise it is bundled but dead.
        expect(observation.alpha, `${observation.key} produced no signal`).toBeGreaterThan(0);

        if (observation.strategy === "isolated") {
            // Observes a browser-owned source, so a second instance gets its own feed.
            expect(observation.beta, `${observation.key} did not reach the second instance`)
                .toBeGreaterThan(0);
        } else {
            // Patches a global, so exactly one instance owns it.
            expect(observation.beta, `${observation.key} leaked into a non-owning instance`)
                .toBe(0);
        }
    }
});

test("a global-patching instrumentation double-reports without an owner", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-status]")).toHaveText("PASS", { timeout: 20000 });

    const result = await page.evaluate(() => window.pocResult);
    // Two instances both enabling fetch instrumentation means one request is reported twice.
    // This is why a shared patch needs a single designated owner.
    expect(result?.sharedPatch.spansForOneRequest).toBe(2);
    expect(result?.sharedPatch.observedBy).toEqual(["alpha", "gamma"]);
});
