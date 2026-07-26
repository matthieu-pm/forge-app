import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "./tests/electron",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run dev",
    reuseExistingServer: true,
    timeout: 120_000,
    url: "http://localhost:3000/login",
  },
})
