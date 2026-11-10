// Run with Bun: the existing TypeScript implementation is the reference oracle.
import { createHash, createHmac, scryptSync } from "node:crypto"
import { createRequire } from "node:module"
import { readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { API_SCOPES } from "../apps/forge/src/application/actor.ts"
import { hasScope, canManageTeams, canReadAllPrivateTeams } from "../apps/forge/src/application/authorization.ts"
import { canManageWorkspaceModelConnections } from "../apps/forge/src/application/agents/agent-authorization.ts"
import { isTeamVisible, isProjectVisible, isDocumentVisible, canShareDocumentWithWorkspace } from "../apps/forge/src/application/resource-visibility.ts"
import { canonicalCommandInput } from "../apps/forge/src/lib/canonical-json.ts"
import { permissionsToScopes } from "../apps/forge/src/application/api-keys/api-key-contract.ts"
import { productFeatures, parseFeatureRollouts, productFeatureMode } from "../packages/environment/product-features.ts"
import { sourceDigest, signJournalRecord, recoveryEvent, journalSource } from "../apps/forge/src/application/recovery/journal.ts"
import { verifyChatGPTIdentity } from "../apps/forge/shared/chatgpt-oauth.ts"
import { security } from "./rust-security-reference.mjs"
import { teamContracts } from "./rust-team-reference.mjs"
import { definitionCases, transitionCases } from "./rust-definition-reference.mjs"

const teams = [
  { workspaceId: "w1", visibility: "workspace", memberUserIds: [] },
  { workspaceId: "w1", visibility: "private", memberUserIds: ["alice"] },
  { workspaceId: "w1", visibility: "private", memberUserIds: ["bob"] },
  { workspaceId: "w2", visibility: "workspace", memberUserIds: ["alice"] },
]
const projects = [
  { workspaceId: "w1", teams: [] },
  { workspaceId: "w1", teams: [teams[0], teams[2]] },
  { workspaceId: "w1", teams: [teams[2]] },
  { workspaceId: "w1", teams: [teams[3]] },
  { workspaceId: "w2", teams: [] },
]
const documents = ["w1", "w2"].flatMap(workspaceId => [false, true].flatMap(sharedWithWorkspace => [
  { kind: "workspace" },
  ...teams.flatMap(team => [{ kind: "team", team }, { kind: "issue", team }]),
  ...projects.map(project => ({ kind: "project", project })),
].map(source => ({ workspaceId, sharedWithWorkspace, source }))))
const authentications = [
  { kind: "session", sessionId: "s1" },
  { kind: "apiKey", credentialId: "k1" },
  { kind: "agent", runId: "r1", tokenId: "t1" },
  { kind: "loop", loopId: "l1", runId: "r1" },
]
const actors = ["member", "guest", "admin", "member, admin", "owner", "not-admin"].flatMap(workspaceRole => authentications.flatMap(authentication => [
  null, [], ["issues:read"], ["teams:read"], ["teams:write", "model-connections:write"], [...API_SCOPES],
].map(scopes => ({ userId: "alice", workspaceId: "w1", workspaceRole, authentication, scopes }))))
const actorCases = actors.map(actor => ({
  actor,
  scopes: API_SCOPES.map(scope => hasScope(actor, scope)),
  canManageTeams: canManageTeams(actor),
  canReadAllPrivateTeams: canReadAllPrivateTeams(actor),
  canManageWorkspaceModels: canManageWorkspaceModelConnections(actor),
  teams: teams.map(team => isTeamVisible(actor, team)),
  projects: projects.map(project => isProjectVisible(actor, project)),
  documents: documents.map(document => isDocumentVisible(actor, document)),
  documentSharing: documents.map(document => canShareDocumentWithWorkspace(actor, document)),
}))
const jsonValues = [null, true, "line\nquote\"😀", [], {},
  { z: 1, a: { b: 2, a: false }, array: [null, "value", 1] },
  { "\uE000": 1, "😀": 2, "a": 3, "𐀀": 4 },
  ...[-0, 1.0, 1e-7, 1e-6, 1e20, 1e21, 0.000123456789, 9007199254740992, -2.5].map(number => ({ number })),
]
const canonical = jsonValues.map(value => {
  const serialized = canonicalCommandInput(value)
  return { value, serialized, hash: createHash("sha256").update(serialized).digest("hex") }
})
const permissionValues = [null, [], {}, { teams: ["read", "write"], issues: ["read"], agents: ["approve"] }, { unknown: ["read"], teams: "read", issues: [null, false, "write", "read", "read"] }]

const requireFromApp = createRequire(new URL("../apps/forge/package.json", import.meta.url))
const requireFromAuth = createRequire(requireFromApp.resolve("better-auth"))
const passwordModule = await import(pathToFileURL(requireFromAuth.resolve("@better-auth/utils/password")))
const cryptoModule = await import(new URL("./crypto.mjs", pathToFileURL(requireFromAuth.resolve("better-call"))))
const password = "pássword-Å①"
const salt = "00112233445566778899aabbccddeeff"
const hash = `${salt}:${scryptSync(password.normalize("NFKC"), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 67108864 }).toString("hex")}`
if (!await passwordModule.verifyPassword(hash, password)) throw new Error("Reference password compatibility failed")
const crypto = {
  password: { password, normalized: password.normalize("NFKC"), hash },
  cookies: await Promise.all(["token-with.dots", "test-session-token"].map(async token => ({ token, secret: "test-fixture-secret-only", signed: await cryptoModule.signCookieValue(token, "test-fixture-secret-only") }))),
}

const { SignJWT, CompactSign } = await import(pathToFileURL(requireFromAuth.resolve("jose")))
crypto.invite = { secret: "test-workspace-invite-secret-only-1234", claims: { generation: 7, workspaceId: "workspace-fixture" } }
crypto.invite.token = await new CompactSign(new TextEncoder().encode(JSON.stringify(crypto.invite.claims))).setProtectedHeader({alg:"HS256",typ:"forge-workspace-invite"}).sign(createHmac("sha256",crypto.invite.secret).update("forge-workspace-invite-link:v1").digest())
const jwtNow = 1700000000
crypto.jwt = {
  now: jwtNow, email: "Test@Example.test", secret: "test-fixture-secret-only",
  token: await new SignJWT({ email: "test@example.test" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt(jwtNow).setExpirationTime(jwtNow + 3600).sign(new TextEncoder().encode("test-fixture-secret-only")),
}
const features = [undefined, "null", "[]", "{}", '{"unknown":{"mode":"enabled","workspaceIds":["w1"]}}',
  JSON.stringify({ sla: { mode: "enabled", workspaceIds: ["w1"] }, billing: { mode: "enabled", workspaceIds: ["w1"] }, signals: { mode: "preview", workspaceIds: ["w1"] } }),
  JSON.stringify({ insights: { mode: "enabled", workspaceIds: ["w1"] } }),
  JSON.stringify({ sla: { mode: "enabled", workspaceIds: ["*"] } }),
  JSON.stringify({ sla: { mode: "enabled", workspaceIds: [" w1"] } }),
].map(raw => {
  let valid = true
  try { parseFeatureRollouts(raw) } catch { valid = false }
  return { raw: raw ?? null, valid, cases: Object.keys(productFeatures).flatMap(feature => ["w1", "w2", ""].flatMap(workspaceId => [false, true].map(billing => ({ feature, workspaceId, billing, mode: productFeatureMode(feature, workspaceId, { FORGE_FEATURE_ROLLOUTS: raw, FORGE_BILLING_ENABLED: String(billing) }) })))) }
})

const journalFixtureSource = { branchId: "br-rust-fixture", host: "ep-fixture.eu-west-2.aws.neon.tech", database: "forge_fixture", storeId: "store_fixture" }
const event = { id: "00000000-0000-4000-8000-000000000001", sequence: 1, table: "issues", key: { id: "00000000-0000-4000-8000-000000000002" }, action: "patch", patch: { status: "deleted", version: 1.0 }, storageReference: null, at: "2026-11-10T12:00:00.000Z" }
const journalKey = Buffer.alloc(32, 9)
const baseRecord = { version: 1, source: journalFixtureSource, operationId: "00000000-0000-4000-8000-000000000003", at: event.at }
const journal = {
  source: journalFixtureSource, sourceDigest: sourceDigest(journalFixtureSource), keyHex: journalKey.toString("hex"),
  signed: [
    { ...baseRecord, kind: "prepared" }, { ...baseRecord, kind: "chunk", events: [event] },
    { ...baseRecord, kind: "completed", chunks: ["chunk-0.json"] }, { ...baseRecord, kind: "aborted" },
  ].map(record => signJournalRecord(record, journalKey)),
  events: [event, { ...event, action: "delete", patch: null },
    { ...event, action: "delete" }, { ...event, patch: { password: "must-not-be-journaled" } },
    { ...event, patch: { password: null } }, { ...event, key: {} }, { ...event, sequence: 0 },
    { ...event, patch: { transcript: ["private-content"] } }, { ...event, patch: { transcript: [] } },
    { ...event, action: "upsert", table: "call_settings", key: { workspace_id: "w1" }, patch: { retention_days: 30 } },
    { ...event, patch: { unsupported_field: true } },
  ].map(value => ({ value, valid: recoveryEvent.safeParse(value).success })),
  sources: [journalFixtureSource, { ...journalFixtureSource, host: "localhost" }, { ...journalFixtureSource, storeId: "store_" }].map(value => ({ value, valid: journalSource.safeParse(value).success })),
}
const oidc = JSON.parse(readFileSync(new URL("../rust/oidc-fixtures.json", import.meta.url), "utf8"))
const originalFetch = globalThis.fetch
globalThis.fetch = async input => {
  const url = String(input instanceof Request ? input.url : input)
  if (url === "https://auth.openai.com/.well-known/openid-configuration") return Response.json({ issuer: "https://auth.openai.com", authorization_endpoint: "https://auth.openai.com/api/accounts/authorize", token_endpoint: "https://auth.openai.com/api/accounts/oauth/token", jwks_uri: "https://auth.openai.com/.well-known/jwks.json" })
  if (url === "https://auth.openai.com/.well-known/jwks.json") return Response.json(oidc.jwks)
  throw new Error("Unexpected network access in OIDC reference fixture export")
}
try {
  for (const fixture of oidc.cases) {
    try {
      const identity = await verifyChatGPTIdentity(fixture.token, oidc.clientId, oidc.nonce)
      fixture.valid = true
      fixture.identity = { ...identity, image: identity.image ?? null }
    } catch {
      fixture.valid = false
    }
  }
} finally {
  globalThis.fetch = originalFetch
}
const output = JSON.stringify({ teams, projects, documents, actorCases, canonical, permissions: permissionValues.map(value => ({ value, scopes: permissionsToScopes(value) })), crypto, features, journal, oidc, security, teamContracts, definitionCases, transitionCases }) + "\n"
const defaultsDestination=new URL("../rust/crates/forge-core/data/issue-definitions.json",import.meta.url)
const defaultsOutput=JSON.stringify(teamContracts.defaults,null,2)+"\n"
if(process.argv.includes("--check")){
  if(readFileSync(defaultsDestination,"utf8")!==defaultsOutput){console.error("Reference default definitions changed.");process.exitCode=1}
}else{writeFileSync(defaultsDestination,defaultsOutput)}
const destination = new URL("../rust/reference-fixtures.json", import.meta.url)
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== output) {
    console.error("Rust reference fixtures changed. Review the source behavior before updating them.")
    process.exitCode = 1
  }
} else {
  writeFileSync(destination, output)
  console.log(`Exported ${actorCases.length} authority cases, ${documents.length} document contexts and credential/canonical fixtures from the reference implementation.`)
}
