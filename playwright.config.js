import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./smoke",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: {
    command: "node smoke/static-server.mjs public 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
});
