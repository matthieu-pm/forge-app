import { electronProxyClient } from "@better-auth/electron/proxy"
import { apiKeyClient } from "@better-auth/api-key/client"
import { createAuthClient } from "better-auth/react"
import {
  inferAdditionalFields,
  organizationClient,
} from "better-auth/client/plugins"

import { desktopCallbackProtocol } from "@/lib/auth-session"
import { profileUserFields } from "@/lib/profile-fields"

const desktopProtocol =
  typeof window === "undefined"
    ? desktopCallbackProtocol("")
    : desktopCallbackProtocol(window.location.search)

export const authClient = createAuthClient({
  plugins: [
    inferAdditionalFields({
      user: profileUserFields,
    }),
    organizationClient(),
    apiKeyClient(),
    electronProxyClient({
      protocol: desktopProtocol,
    }),
  ],
})
