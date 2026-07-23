import { electronProxyClient } from "@better-auth/electron/proxy"
import { apiKeyClient } from "@better-auth/api-key/client"
import { createAuthClient } from "better-auth/react"
import { organizationClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  plugins: [
    organizationClient(),
    apiKeyClient(),
    electronProxyClient({
      protocol: "com.forge.desktop",
    }),
  ],
})
