import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwind from "@tailwindcss/vite"

const fixture = fileURLToPath(new URL(".", import.meta.url))
const source = fileURLToPath(new URL("../../../src", import.meta.url))
export default defineConfig({
  root: fixture,
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: "./account-preference-provider",
        replacement: `${fixture}/provider.ts`,
      },
      { find: "./feature-availability", replacement: `${fixture}/provider.ts` },
      {
        find: "@/lib/preference-import-state",
        replacement: `${fixture}/state.ts`,
      },
      {
        find: /^@tanstack\/react-start(?:\/server(?:-only)?)?$/,
        replacement: `${fixture}/../person-names/server-stub.ts`,
      },
      { find: "@", replacement: source },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 3144,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../../../../../", import.meta.url))] },
  },
})
