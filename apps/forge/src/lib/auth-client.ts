import { electronProxyClient } from "@better-auth/electron/proxy"
import { apiKeyClient } from "@better-auth/api-key/client"
import { createAuthClient } from "better-auth/react"
import {
  inferAdditionalFields,
  organizationClient,
} from "better-auth/client/plugins"

import { desktopCallbackProtocol } from "@/lib/auth-session"
import { profileUserFields } from "@/lib/profile-fields"
import { invalidateNavigationAuthState } from "@/lib/auth-state"

const desktopProtocol =
  typeof window === "undefined"
    ? desktopCallbackProtocol("")
    : desktopCallbackProtocol(window.location.search)

export const authClient = createAuthClient({
  fetchOptions: {
    // Clear before and after mutations so an overlapping read cannot retain
    // the previous account or workspace after sign-in, sign-out or switching.
    onRequest: (request) => {
      const { method, url, headers } = request
      if (method !== "GET") invalidateNavigationAuthState()
      // The SDK's deferred refresh POST has no body, but the auth endpoint
      // requires a JSON content type even for this empty request.
      if (method === "POST" && new URL(url).pathname.endsWith("/get-session")) {
        headers.set("Content-Type", "application/json")
        request.body = "{}"
      }
    },
    onSuccess: ({ request }) => {
      if (request.method !== "GET") invalidateNavigationAuthState()
    },
    onError: ({ response }) => {
      if (response.status === 401) invalidateNavigationAuthState()
    },
  },
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
