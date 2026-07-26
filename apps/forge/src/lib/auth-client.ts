import { electronProxyClient } from "@better-auth/electron/proxy"
import { apiKeyClient } from "@better-auth/api-key/client"
import { createAuthClient } from "better-auth/react"
import {
  inferAdditionalFields,
  organizationClient,
} from "better-auth/client/plugins"

import { profileUserFields } from "@/lib/profile-fields"

export const authClient = createAuthClient({
  plugins: [
    inferAdditionalFields({
      user: profileUserFields,
    }),
    organizationClient(),
    apiKeyClient(),
    electronProxyClient({
      protocol: "com.forge.desktop",
    }),
  ],
})
