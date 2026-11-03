import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwind from "@tailwindcss/vite"

const source = fileURLToPath(new URL("../../../src", import.meta.url))
const fixture = fileURLToPath(new URL(".", import.meta.url))
export default defineConfig({
  root: fixture,
  optimizeDeps: { entries: [] },
  plugins: [react(), tailwind()],
  resolve: {
    alias: [
      {
        find: /^@tanstack\/react-start(?:\/server(?:-only)?)?$/,
        replacement: `${fixture}/server-stub.ts`,
      },
      { find: /^@\/lib\/auth-client$/, replacement: `${fixture}/auth-stub.ts` },
      {
        find: /^@\/lib\/issue-comment-state$/,
        replacement: `${fixture}/comments-stub.ts`,
      },
      { find: "@", replacement: source },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 3130,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../../../../../", import.meta.url))] },
  },
})
