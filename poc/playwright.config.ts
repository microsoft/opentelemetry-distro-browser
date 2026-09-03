import { defineConfig } from "@playwright/test";

export default defineConfig({
    testDir: "tests",
    use: {
        baseURL: "http://127.0.0.1:4173",
        browserName: "chromium",
        channel: process.env.CI ? undefined : "msedge"
    },
    webServer: {
        command: "npm run preview -- --host 127.0.0.1 --port 4173",
        url: "http://127.0.0.1:4173",
        reuseExistingServer: !process.env.CI
    }
});