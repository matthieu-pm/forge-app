// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  exchangeChatGPTToken,
  verifyChatGPTIdentity,
} from "../../shared/chatgpt-oauth"
import {
  chatGPTWebsiteConfigured,
  chatGPTWebsiteProvider,
  websiteNonce,
} from "./chatgpt-auth.server"

vi.mock("../../shared/chatgpt-oauth", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  chatGPTDiscovery: async () => ({
    authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
  }),
  exchangeChatGPTToken: vi.fn(),
  verifyChatGPTIdentity: vi.fn(),
}))
beforeEach(() => {
  vi.mocked(exchangeChatGPTToken).mockReset()
  vi.mocked(verifyChatGPTIdentity).mockReset()
})
describe("ChatGPT website identity", () => {
  it("requires a registered client and the configured authentication method", () => {
    expect(chatGPTWebsiteConfigured({})).toBe(false)
    expect(
      chatGPTWebsiteConfigured({ OPENAI_CLIENT_ID: "dynamic_agent_client" })
    ).toBe(false)
    expect(chatGPTWebsiteConfigured({ OPENAI_CLIENT_ID: "oaiapp_forge" })).toBe(
      true
    )
    expect(
      chatGPTWebsiteConfigured({
        OPENAI_CLIENT_ID: "oaiapp_forge",
        OPENAI_CLIENT_AUTH_METHOD: "client_secret_basic",
      })
    ).toBe(false)
  })
  it("binds identity-only authorization to PKCE and a nonce", async () => {
    const provider = chatGPTWebsiteProvider("oaiapp_forge")
    const url = await provider.createAuthorizationURL({
      state: "state",
      codeVerifier: "verifier",
      redirectURI: "https://forge.test/api/auth/callback/chatgpt",
    })
    expect(url.searchParams.get("scope")).toBe("openid profile email")
    expect(url.searchParams.get("nonce")).toBe(websiteNonce("verifier"))
    expect(url.searchParams.get("code_challenge")).not.toBe(
      websiteNonce("verifier")
    )
    expect(url.searchParams.get("state")).toBe("state")
  })
  it("verifies identity without retaining any raw OpenAI token", async () => {
    vi.mocked(exchangeChatGPTToken).mockResolvedValue({
      id_token: "private-id-token",
      access_token: "private-access-token",
    })
    vi.mocked(verifyChatGPTIdentity).mockResolvedValue({
      subject: "subject",
      email: "user@example.test",
      name: "User",
      emailVerified: true,
      image: undefined,
    })
    const provider = chatGPTWebsiteProvider("oaiapp_forge")
    const tokens = await provider.validateAuthorizationCode({
      code: "code",
      codeVerifier: "verifier",
      redirectURI: "https://forge.test/api/auth/callback/chatgpt",
    })
    expect(verifyChatGPTIdentity).toHaveBeenCalledWith(
      "private-id-token",
      "oaiapp_forge",
      websiteNonce("verifier")
    )
    expect(JSON.stringify(tokens)).not.toContain("private-")
    expect((await provider.getUserInfo(tokens!))?.user.id).toBe(
      "https://auth.openai.com|oaiapp_forge|subject"
    )
  })
  it("fails closed on invalid identity and redacts token errors", async () => {
    vi.mocked(exchangeChatGPTToken).mockResolvedValue({
      id_token: "private-token",
    })
    vi.mocked(verifyChatGPTIdentity).mockRejectedValue(
      new Error("private-token")
    )
    const provider = chatGPTWebsiteProvider("oaiapp_forge")
    await expect(
      provider.validateAuthorizationCode({
        code: "code",
        codeVerifier: "verifier",
        redirectURI: "https://forge.test/callback",
      })
    ).rejects.toThrow("ChatGPT sign-in could not be verified")
  })
})
