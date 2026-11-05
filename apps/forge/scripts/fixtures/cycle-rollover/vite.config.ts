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
      { find: "@/lib/team-cycles", replacement: `${fixture}/state.ts` },
      { find: "@/hooks/use-calendar-week", replacement: `${fixture}/state.ts` },
      { find: "@tanstack/react-router", replacement: `${fixture}/router.tsx` },
      {
        find: /^@tanstack\/react-start(?:\/server(?:-only)?)?$/,
        replacement: `${fixture}/../person-names/server-stub.ts`,
      },
      { find: "@", replacement: source },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 3169,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../../../../../", import.meta.url))] },
  },
})
