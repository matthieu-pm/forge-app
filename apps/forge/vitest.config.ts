import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    clearMocks: true,
    environment: "jsdom",
    exclude: [
      ...configDefaults.exclude,
      "tests/electron/**",
      "services/agent-runtime/**",
      "src/workflows/**/*.test.ts",
    ],
    passWithNoTests: false,
    restoreMocks: true,
  },
})
