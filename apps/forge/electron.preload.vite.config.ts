import { defineConfig } from "vite"

import { processConfig } from "./electron.vite.config"

export default defineConfig(
  processConfig("electron/preload/preload.ts", "preload.cjs", "cjs")
)
