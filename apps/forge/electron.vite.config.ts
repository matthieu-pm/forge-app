import { builtinModules } from "node:module"
import { resolve } from "node:path"
import { defineConfig, loadEnv } from "vite"
import type { UserConfig } from "vite"

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((module) => `node:${module}`),
  "electron",
]
const repositoryRoot = resolve(import.meta.dirname, "../..")

export function processConfig(
  input: string,
  output: string,
  format: "es" | "cjs"
): UserConfig {
  return {
    publicDir: false,
    build: {
      emptyOutDir: false,
      lib: {
        entry: resolve(import.meta.dirname, input),
        formats: [format],
        fileName: () => output,
      },
      minify: false,
      outDir: resolve(import.meta.dirname, ".electron-build"),
      rollupOptions: {
        external: nodeBuiltins,
      },
      sourcemap: false,
      target: "node22",
    },
    resolve: {
      conditions: ["node"],
    },
  }
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, repositoryRoot, "")
  const appOrigin =
    process.env.FORGE_DESKTOP_APP_ORIGIN ||
    environment.FORGE_DESKTOP_APP_ORIGIN ||
    "https://forge.invalid"
  const updateBaseUrl =
    process.env.FORGE_DESKTOP_UPDATE_BASE_URL ||
    environment.FORGE_DESKTOP_UPDATE_BASE_URL ||
    ""

  return {
    ...processConfig("electron/main/main.ts", "main.js", "es"),
    build: {
      ...processConfig("electron/main/main.ts", "main.js", "es").build,
      emptyOutDir: true,
    },
    define: {
      __FORGE_DESKTOP_APP_ORIGIN__: JSON.stringify(appOrigin),
      __FORGE_DESKTOP_UPDATE_BASE_URL__: JSON.stringify(updateBaseUrl),
    },
  }
})
