import { defineConfig } from "vitest/config";
import config, { browserInstances } from "./vitest.config.js";
import {
  inspectCrossSiteCookieCleanup,
  loadSnippetPage,
} from "./test/integration/snippetPageCommand.js";
import { inspectPageVisitNamespaces } from "./test/integration/pageVisitNamespaceCommand.js";
import { verifyReloadDelivery, verifyUnloadDelivery } from "./test/integration/unloadCommand.js";

export default defineConfig({
  ...config,
  resolve: { ...config.resolve, alias: [] },
  test: {
    ...config.test,
    // Commands create extra contexts and popups outside Vitest's managed-page budget.
    // Avoid resource contention between files without changing within-test concurrency.
    fileParallelism: false,
    // Keep unit mocks out of integration tests.
    setupFiles: [],
    browser: {
      ...config.test?.browser,
      commands: {
        inspectCrossSiteCookieCleanup,
        loadSnippetPage,
        inspectPageVisitNamespaces,
        verifyReloadDelivery,
        verifyUnloadDelivery,
      },
      instances: browserInstances,
    },
    globalSetup: ["./test/integration/redirectServer.ts", "./test/integration/cdnServer.ts"],
    include: ["test/integration/**/*.test.ts"],
  },
});
