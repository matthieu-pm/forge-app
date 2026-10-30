import { getVercelOidcToken } from "@vercel/oidc"
import { STAGING } from "./staging-environment.js"
import { isPreviewProfile, previewPeerOrigin } from "./preview-environment.js"

/** Send a short-lived service identity only to the reviewed staging peer; refuse redirects. */
export const stagingServiceFetch: typeof fetch = (input, init) =>
  fetchWithStagingIdentity(input, init)

export async function fetchWithStagingIdentity(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  fetcher: typeof fetch = fetch
) {
  const preview = isPreviewProfile(process.env)
  if (!preview && process.env.FORGE_ENVIRONMENT !== "staging")
    return fetcher(input, init)
  const origin = new URL(
    input instanceof Request ? input.url : input.toString()
  ).origin
  const peer = preview
    ? previewPeerOrigin(process.env)
    : process.env.VERCEL_PROJECT_ID === STAGING.webProjectId
      ? STAGING.runtimeOrigin
      : process.env.VERCEL_PROJECT_ID === STAGING.runtimeProjectId
        ? STAGING.webOrigin
        : null
  if (origin !== peer)
    throw new Error("Staging service identity cannot be sent to this origin.")
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined)
  )
  headers.set("x-vercel-trusted-oidc-idp-token", await getVercelOidcToken())
  return fetcher(input, { ...init, headers, redirect: "error" })
}
