import { electronProxyClient } from "@better-auth/electron/proxy"
import { apiKeyClient } from "@better-auth/api-key/client"
import { createAuthClient } from "better-auth/react"
import {
  inferAdditionalFields,
  organizationClient,
} from "better-auth/client/plugins"
import {
  broadcastSessionInvalidation,
  invalidatePreferenceSession,
} from "./preference-session-events"

import { desktopCallbackProtocol } from "@/lib/auth-session"
import { profileUserFields } from "@/lib/profile-fields"
import { invalidateNavigationAuthState } from "@/lib/auth-state"

const desktopProtocol =
  typeof window === "undefined"
    ? desktopCallbackProtocol("")
    : desktopCallbackProtocol(window.location.search)

function changesPreferenceIdentity(url: unknown) {
  return (
    typeof url === "string" &&
    /\/api\/auth\/(?:sign-in(?:\/|$)|sign-up(?:\/|$)|sign-out(?:\?|$)|delete-user(?:\?|$)|organization\/set-active(?:\?|$)|revoke-(?:session|sessions|other-sessions)(?:\?|$))/.test(
      url
    )
  )
}

export const authClient = createAuthClient({
  fetchOptions: {
    // Better Fetch's HTTP hooks do not run when the transport rejects.
    customFetchImpl: async (input, init) => {
      try {
        return await globalThis.fetch(input, init)
      } catch (error) {
        const url = input instanceof Request ? input.url : String(input)
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET")
        if (method !== "GET" && changesPreferenceIdentity(url)) {
          invalidateNavigationAuthState()
          invalidatePreferenceSession("settled")
          broadcastSessionInvalidation("settled")
        }
        throw error
      }
    },
    // Clear before and after mutations so an overlapping read cannot retain
    // the previous account or workspace after sign-in, sign-out or switching.
    onRequest: (request) => {
      const { method, url, headers } = request
      if (method !== "GET") invalidateNavigationAuthState()
      if (method !== "GET" && changesPreferenceIdentity(url)) {
        invalidatePreferenceSession("start")
        broadcastSessionInvalidation("start")
      }
      // The SDK's deferred refresh POST has no body, but the auth endpoint
      // requires a JSON content type even for this empty request.
      if (method === "POST" && new URL(url).pathname.endsWith("/get-session")) {
        headers.set("Content-Type", "application/json")
        request.body = "{}"
      }
    },
    onSuccess: ({ request }) => {
      if (request.method !== "GET") invalidateNavigationAuthState()
      if (request.method !== "GET" && changesPreferenceIdentity(request.url)) {
        invalidatePreferenceSession("settled")
        broadcastSessionInvalidation("settled")
      }
    },
    onError: ({ request, response }) => {
      if (response.status === 401 || changesPreferenceIdentity(request?.url)) {
        invalidatePreferenceSession("settled")
        broadcastSessionInvalidation("settled")
      }
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
