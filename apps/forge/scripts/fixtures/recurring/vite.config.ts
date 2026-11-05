import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwind from "@tailwindcss/vite"
const fixture = fileURLToPath(new URL(".", import.meta.url))
export default defineConfig({
  root: fixture,
  plugins: [react(), tailwind()],
  optimizeDeps: { entries: [] },
  resolve: {
    alias: [
      {
        find: /^@tanstack\/react-start(?:\/server(?:-only)?)?$/,
        replacement: `${fixture}/server-stub.ts`,
      },
      { find: /^@\/lib\/auth-client$/, replacement: `${fixture}/auth-stub.ts` },
      {
        find: /^(?:@\/lib\/|\.\/)product-state-server$/,
        replacement: `${fixture}/storage-stub.ts`,
      },
      {
        find: /^@\/lib\/recurring-issue-state$/,
        replacement: `${fixture}/recurring-stub.ts`,
      },
      {
        find: "@",
        replacement: fileURLToPath(new URL("../../../src", import.meta.url)),
      },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 3168,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../../../../../", import.meta.url))] },
  },
})
