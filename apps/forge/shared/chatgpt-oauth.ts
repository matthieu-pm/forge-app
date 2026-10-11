import { createHash } from "node:crypto"
import { createRemoteJWKSet, jwtVerify } from "jose"
import { z } from "zod"

export const CHATGPT_ISSUER = "https://auth.openai.com"
export const CHATGPT_RESOURCE = "https://api.openai.com/v1"
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct"
export const CHATGPT_SCOPES =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
const discoverySchema = z.object({
  issuer: z.literal(CHATGPT_ISSUER),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
  revocation_endpoint: z.url().optional(),
})
let discovery: Promise<z.infer<typeof discoverySchema>> | undefined
const keys = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
export async function chatGPTDiscovery() {
  discovery ??= (async () => {
    const response = await fetch(
      `${CHATGPT_ISSUER}/.well-known/openid-configuration`,
      { signal: AbortSignal.timeout(15_000), redirect: "error" }
    )
    if (!response.ok)
      throw new Error("ChatGPT sign-in is unavailable. Try again.")
    const result = discoverySchema.parse(await response.json())
    for (const value of [
      result.authorization_endpoint,
      result.token_endpoint,
      result.jwks_uri,
      result.revocation_endpoint,
    ].filter(Boolean)) {
      if (new URL(value!).origin !== CHATGPT_ISSUER)
        throw new Error("Invalid ChatGPT discovery endpoint.")
    }
    return result
  })().catch((error) => {
    discovery = undefined
    throw error
  })
  return discovery
}
export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url")
}
export async function verifyChatGPTIdentity(
  idToken: string,
  clientId: string,
  nonce: string
) {
  const config = await chatGPTDiscovery()
  let jwks = keys.get(config.jwks_uri)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(config.jwks_uri))
    keys.set(config.jwks_uri, jwks)
  }
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: config.issuer,
    audience: clientId,
    requiredClaims: ["sub", "exp", "iat", "nonce"],
    clockTolerance: 5,
  })
  if (!payload.sub || payload.nonce !== nonce)
    throw new Error("ChatGPT identity could not be verified.")
  return {
    subject: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    name: typeof payload.name === "string" ? payload.name : null,
    image: typeof payload.picture === "string" ? payload.picture : undefined,
    emailVerified: payload.email_verified === true,
  }
}
export const chatGPTTokensSchema = z.object({
  id_token: z.string().min(1).optional(),
  access_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
})
export async function exchangeChatGPTToken(
  body: URLSearchParams,
  clientSecret?: string
) {
  const config = await chatGPTDiscovery()
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  }
  if (clientSecret) {
    const encode = (value: string) =>
      new URLSearchParams({ value }).toString().slice(6)
    headers.authorization = `Basic ${Buffer.from(`${encode(body.get("client_id")!)}:${encode(clientSecret)}`).toString("base64")}`
  }
  const response = await fetch(config.token_endpoint, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok)
    throw new Error(
      response.status === 400 || response.status === 401
        ? "ChatGPT authorization expired. Continue with ChatGPT again."
        : "ChatGPT sign-in is unavailable. Try again."
    )
  return chatGPTTokensSchema.parse(await response.json())
}
