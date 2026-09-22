import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  optimizeDeps: {
    include: [
      "@opentelemetry/api",
      "@opentelemetry/api-logs",
      "@opentelemetry/browser-sdk",
      "@opentelemetry/core",
      "@opentelemetry/instrumentation",
      "@opentelemetry/resources",
      "@opentelemetry/sdk-logs",
      "@opentelemetry/sdk-trace-base",
      "@opentelemetry/semantic-conventions",
      "@opentelemetry/semantic-conventions/incubating",
    ],
  },
  test: {
    include: ["test/internal/unit/**/*.test.ts"],
    reporters: ["default"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
