// Playwright config for the admin-auth v2 UI (spec §10). Headless, traces on
// failure only. Requires @playwright/test:  npm i -D @playwright/test && npx playwright install chromium
// Run:  BASE_URL=http://127.0.0.1:8787 npx playwright test --config=tests/auth/ui/playwright.config.mjs
import { defineConfig, devices } from "@playwright/test";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 5"] } },
  ],
});
