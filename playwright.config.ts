import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results",
  workers: 1,
  timeout: 90_000,
  reporter: [["line"]],
  use: {
    baseURL: "http://127.0.0.1:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm dev:e2e",
    url: "http://127.0.0.1:3000",
    reuseExistingServer: true,
    timeout: 30_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile-320", use: { ...devices["Pixel 5"], viewport: { width: 320, height: 720 } } },
    { name: "review-1024", grep: /@receipt-review/, use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 } } },
    { name: "review-768", grep: /@receipt-review/, use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 } } },
    { name: "review-390", grep: /@receipt-review/, use: { ...devices["Pixel 5"], viewport: { width: 390, height: 844 } } },
    { name: "review-zoom-200", grep: /@receipt-review/, use: {
      ...devices["Desktop Chrome"], viewport: { width: 320, height: 720 }, deviceScaleFactor: 2,
    } },
  ],
});
