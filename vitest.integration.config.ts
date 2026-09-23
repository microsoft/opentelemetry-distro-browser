import { defineConfig } from "vitest/config";
import config from "./vitest.config.js";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    globalSetup: ["./test/integration/redirectServer.ts"],
    include: ["test/integration/**/*.test.ts"],
  },
});
