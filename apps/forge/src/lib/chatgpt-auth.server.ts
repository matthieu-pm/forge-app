import {
  chatGPTDiscovery,
  exchangeChatGPTToken,
  pkceChallenge,
  verifyChatGPTIdentity,
} from "../../shared/chatgpt-oauth"
import type { BetterAuthPlugin } from "better-auth"
import type { OAuthProvider } from "@better-auth/core/oauth2"

export function chatGPTWebsiteConfigured(
  env: Record<string, string | undefined> = process.env
) {
  const method = env.OPENAI_CLIENT_AUTH_METHOD ?? "none"
  return Boolean(
    env.OPENAI_CLIENT_ID?.startsWith("oaiapp_") &&
    (method === "none" ||
      (method === "client_secret_basic" && env.OPENAI_CLIENT_SECRET))
  )
}
// Domain-separated from the PKCE challenge; the random verifier is bound to
// Better Auth's expiring, single-use, browser-bound OAuth transaction.
export const websiteNonce = (verifier: string) =>
  pkceChallenge(`forge-chatgpt-nonce:${verifier}`)
export function chatGPTWebsiteProvider(
  clientId: string,
  clientSecret?: string
): OAuthProvider {
  return {
    id: "chatgpt",
    name: "ChatGPT",
    async createAuthorizationURL({ state, codeVerifier, redirectURI }) {
      const config = await chatGPTDiscovery()
      const url = new URL(config.authorization_endpoint)
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectURI,
        response_type: "code",
        scope: "openid profile email",
        state,
        nonce: websiteNonce(codeVerifier),
        code_challenge_method: "S256",
        code_challenge: pkceChallenge(codeVerifier),
      }).toString()
      return url
    },
    async validateAuthorizationCode({ code, codeVerifier, redirectURI }) {
      try {
        if (!codeVerifier) throw new Error("Missing verifier")
        const tokens = await exchangeChatGPTToken(
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            code_verifier: codeVerifier,
            redirect_uri: redirectURI,
          }),
          clientSecret
        )
        if (!tokens.id_token) throw new Error("Missing identity")
        const identity = await verifyChatGPTIdentity(
          tokens.id_token,
          clientId,
          websiteNonce(codeVerifier)
        )
        // Only verified identity reaches Better Auth. No OpenAI tokens are stored
        // in Forge's remotely hosted account database.
        return { raw: { identity } }
      } catch {
        throw new Error(
          "ChatGPT sign-in could not be verified. Please try again."
        )
      }
    },
    async getUserInfo(tokens) {
      const identity = tokens.raw?.identity as
        Awaited<ReturnType<typeof verifyChatGPTIdentity>> | undefined
      if (!identity?.email) return null
      return {
        user: {
          id: `${"https://auth.openai.com"}|${clientId}|${identity.subject}`,
          email: identity.email,
          name: identity.name ?? identity.email,
          image: identity.image,
          emailVerified: identity.emailVerified,
        },
        data: {},
      }
    },
  }
}
export function chatGPTAuth(): BetterAuthPlugin {
  return {
    id: "forge-chatgpt",
    init(ctx) {
      if (!chatGPTWebsiteConfigured()) return
      const provider = chatGPTWebsiteProvider(
        process.env.OPENAI_CLIENT_ID!,
        process.env.OPENAI_CLIENT_AUTH_METHOD === "client_secret_basic"
          ? process.env.OPENAI_CLIENT_SECRET
          : undefined
      )
      return {
        context: { socialProviders: [...ctx.socialProviders, provider] },
      }
    },
  }
}
