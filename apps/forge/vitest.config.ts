import { configDefaults, defineConfig } from "vitest/config"
import viteTsConfigPaths from "vite-tsconfig-paths"

export default defineConfig({
  plugins: [
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
  ],
  test: {
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
