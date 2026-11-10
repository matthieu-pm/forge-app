// Explicit fixture regeneration only. Private signing material stays in memory.
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { writeFileSync } from "node:fs"
import { pkceChallenge } from "../apps/forge/shared/chatgpt-oauth.ts"
import { websiteNonce } from "../apps/forge/src/lib/chatgpt-auth.server.ts"

const requireFromApp = createRequire(new URL("../apps/forge/package.json", import.meta.url))
const requireFromAuth = createRequire(requireFromApp.resolve("better-auth"))
const { SignJWT, exportJWK, generateKeyPair } = await import(pathToFileURL(requireFromAuth.resolve("jose")))
const pair = await generateKeyPair("RS256")
const publicKey = { ...await exportJWK(pair.publicKey), kid: "rust-oidc-fixture", alg: "RS256", use: "sig" }
const clientId = "oaiapp_forge"
const verifier = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"
const nonce = websiteNonce(verifier)
const base = { sub: "fixture-subject", iss: "https://auth.openai.com", aud: clientId, iat: 1700000000, exp: 4102444800, nonce, email: "fixture@example.test", email_verified: true, name: "Fixture account", picture: "https://example.test/avatar.png" }
const cases = []
for (const [name, patch] of Object.entries({ valid: {}, wrong_issuer: { iss: "https://untrusted.example" }, wrong_audience: { aud: "oaiapp_other" }, expired: { exp: 1 }, wrong_nonce: { nonce: "another-transaction" }, empty_subject: { sub: "" }, unverified: { email_verified: false }, non_string_profile: { name: 5, picture: false } })) {
  const token = await new SignJWT({ ...base, ...patch }).setProtectedHeader({ alg: "RS256", kid: publicKey.kid }).sign(pair.privateKey)
  cases.push({ name, token })
}
const parts = cases[0].token.split(".")
parts[2] = Buffer.alloc(256).toString("base64url")
cases.push({ name: "forged_signature", token: parts.join(".") })
cases.push({ name: "wrong_algorithm", token: await new SignJWT(base).setProtectedHeader({ alg: "HS256", kid: publicKey.kid }).sign(new TextEncoder().encode("this-is-a-test-fixture-key-only")) })
writeFileSync(new URL("../rust/oidc-fixtures.json", import.meta.url), JSON.stringify({ clientId, verifier, nonce, challenge: pkceChallenge(verifier), jwks: { keys: [publicKey] }, cases }, null, 2) + "\n")
