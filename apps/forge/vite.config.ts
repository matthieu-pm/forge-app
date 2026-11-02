import { resolve } from "node:path"
import { defineConfig, loadEnv } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { nitro } from "nitro/vite"
import { workflow } from "workflow/vite"
import { LOOP_FUNCTION_DURATION_SECONDS } from "./src/application/loops/loop-execution-policy"

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
        vercel: {
          functionRules:
            process.env.FORGE_LOOPS_ENABLED === "true"
              ? {
                  "/api/internal/loops": {
                    maxDuration: LOOP_FUNCTION_DURATION_SECONDS,
                  },
                }
              : {},
          config: {
            version: 3,
            crons: [
              ...(process.env.FORGE_OPERATIONS_MONITOR_ENABLED === "true"
                ? [
                    {
                      path: "/api/internal/operations-monitor",
                      schedule: "* * * * *",
                    },
                  ]
                : []),
              ...(process.env.FORGE_LOOPS_ENABLED === "true"
                ? [{ path: "/api/internal/loops", schedule: "* * * * *" }]
                : []),
            ],
          },
        },
        plugins: [
          resolve(
            import.meta.dirname,
            "server/plugins/service-configuration.ts"
          ),
        ],
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
