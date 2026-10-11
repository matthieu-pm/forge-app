// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { SignJWT, exportJWK, generateKeyPair } from "jose"
import { verifyChatGPTIdentity } from "./chatgpt-oauth"

let pair: Awaited<ReturnType<typeof generateKeyPair>>
beforeAll(async () => {
  pair = await generateKeyPair("RS256")
  const key = {
    ...(await exportJWK(pair.publicKey)),
    kid: "test",
    alg: "RS256",
    use: "sig",
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (input: string | URL) =>
        new Response(
          JSON.stringify(
            String(input).endsWith("openid-configuration")
              ? {
                  issuer: "https://auth.openai.com",
                  authorization_endpoint:
                    "https://auth.openai.com/api/accounts/authorize",
                  token_endpoint:
                    "https://auth.openai.com/api/accounts/oauth/token",
                  jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
                }
              : { keys: [key] }
          ),
          { headers: { "content-type": "application/json" } }
        )
    )
  )
})
afterAll(() => vi.unstubAllGlobals())
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    sub: "subject",
    iss: "https://auth.openai.com",
    aud: "oaiapp_forge",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
    nonce: "expected",
    email: "user@example.test",
    email_verified: true,
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test" })
    .sign(pair.privateKey)
}
describe("ChatGPT ID token verification", () => {
  it("accepts signed identity for this client and transaction", async () => {
    expect(
      await verifyChatGPTIdentity(await token(), "oaiapp_forge", "expected")
    ).toMatchObject({ subject: "subject", emailVerified: true })
  })
  it.each([
    { iss: "https://other.test" },
    { aud: "oaiapp_other" },
    { exp: 1 },
    { nonce: "wrong" },
    { sub: "" },
  ])("rejects invalid identity claims %j", async (claims) => {
    await expect(
      verifyChatGPTIdentity(await token(claims), "oaiapp_forge", "expected")
    ).rejects.toThrow()
  })
  it("rejects a forged signature", async () => {
    const parts = (await token()).split(".")
    parts[2] = Buffer.alloc(256).toString("base64url")
    await expect(
      verifyChatGPTIdentity(parts.join("."), "oaiapp_forge", "expected")
    ).rejects.toThrow()
  })
})
