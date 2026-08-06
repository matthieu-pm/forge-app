import { workflow } from "@workflow/vitest"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  plugins: [
    workflow({
      rootDir: import.meta.dirname,
    }),
    viteReact(),
  ],
  test: {
    environment: "node",
    include: ["src/workflows/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    setupFiles: ["./src/workflows/workflow-vitest-compat.ts"],
  },
})
