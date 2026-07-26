import { workflow } from "@workflow/vitest"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"
import viteTsConfigPaths from "vite-tsconfig-paths"

export default defineConfig({
  plugins: [
    workflow({
      rootDir: import.meta.dirname,
    }),
    viteReact(),
    viteTsConfigPaths({
      projects: ["./tsconfig.json"],
    }),
  ],
  test: {
    environment: "node",
    include: ["src/workflows/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    setupFiles: ["./src/workflows/workflow-vitest-compat.ts"],
  },
})
