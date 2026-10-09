// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { trace } from "@opentelemetry/api";
import { useMicrosoftOpenTelemetry } from "../../src/index.js";

const parameters = new URLSearchParams(location.search);
const ingestionEndpoint = parameters.get("ingestionEndpoint");
const runId = parameters.get("runId");
const pageView = parameters.get("pageView") === "true";
const largeBatch = parameters.get("largeBatch") === "true";
if (!ingestionEndpoint || !runId) {
  throw new Error("Unload fixture requires ingestionEndpoint and runId parameters.");
}

await useMicrosoftOpenTelemetry({
  azureMonitor: {
    connectionString:
      `InstrumentationKey=00000000-0000-0000-0000-000000000000;` +
      `IngestionEndpoint=${ingestionEndpoint}`,
  },
  pageView: { enabled: pageView, softNavigationSettleTimeoutMs: 60_000 },
});
if (pageView) {
  // Keep the route pending until the document navigates away.
  window.requestAnimationFrame = () => 0;
  history.pushState(null, "", "#unsettled");
}
trace
  .getTracer("browser-unload-test")
  .startSpan("navigation-away", { attributes: { "test.run_id": runId } })
  .end();
const tracer = trace.getTracer("browser-unload-test");
const spanCount = largeBatch ? 8 : 1;
for (let index = 0; index < spanCount; index++) {
  tracer
    .startSpan(largeBatch ? `navigation-away-${index}` : "navigation-away", {
      attributes: {
        "test.run_id": runId,
        ...(largeBatch ? { payload: "x".repeat(10 * 1024) } : {}),
      },
    })
    .end();
}
document.body.dataset.ready = "true";
