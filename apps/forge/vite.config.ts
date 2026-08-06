import { resolve } from "node:path"
import { defineConfig, loadEnv } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { nitro } from "nitro/vite"
import { workflow } from "workflow/vite"

const repositoryRoot = resolve(import.meta.dirname, "../..")

const config = defineConfig(({ mode }) => {
  const rootEnvironment = loadEnv(mode, repositoryRoot, "")
  for (const [name, value] of Object.entries(rootEnvironment)) {
    process.env[name] ??= value
  }

  return {
    envDir: repositoryRoot,
    ssr: {
      external: ["@vercel/cli-config", "@vercel/oidc", "xdg-app-paths"],
    },
    preview: {
      port: Number(process.env.FORGE_PRERENDER_PORT ?? 3100),
    },
    resolve: {
      tsconfigPaths: true,
    },
    server: {
      watch: {
        ignored: ["**/.electron-build/**", "**/.output/**"],
      },
    },
    plugins: [
      workflow(),
      devtools(),
      nitro({
        traceDeps: ["@vercel/oidc*", "@vercel/cli-config*", "xdg-app-paths*"],
      }),
      tailwindcss(),
      tanstackStart({
        spa: {
          enabled: true,
        },
      }),
      viteReact(),
    ],
  }
})

export default config
