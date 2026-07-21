import { electronProxyClient } from "@better-auth/electron/proxy"
import { createAuthClient } from "better-auth/react"
import { organizationClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  plugins: [
    organizationClient(),
    electronProxyClient({
      protocol: "com.forge.desktop",
    }),
  ],
})
