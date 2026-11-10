// Imported by the reference exporter; all expected answers come from Forge.
import { domainToASCII } from "node:url"
import { workspaceSecuritySettings } from "../apps/forge/src/db/schema.ts"
import { workspaceSecuritySettingsSchema, workspaceSecurityActionSchema } from "../apps/forge/src/application/workspace-security/security-contract.ts"
import { isWorkspaceActionAllowed, resolveEntitlements } from "../apps/forge/src/application/workspace-security/security-policy.ts"
import { subscriptionAccess } from "../apps/forge/src/application/billing/subscription-access.ts"

const defaults = Object.fromEntries(Object.keys(workspaceSecuritySettingsSchema.shape).map(key => [key, workspaceSecuritySettings[key].default]))
const configurations = [defaults, ...Object.keys(defaults).filter(key => key !== "allowedUploadTypes").map(key => ({ ...defaults, [key]: typeof defaults[key] === "boolean" ? !defaults[key] : defaults[key] === "admins" ? "all-members" : "admins" }))]
const actions = workspaceSecurityActionSchema.options
const roles = ["owner", "admin", "member", "guest", "member, admin", "admin,guest", "not-admin", ""]
const policies = configurations.flatMap(settings => roles.map(workspaceRole => {
  const actor = { userId: "alice", workspaceId: "w1", workspaceRole, authentication: { kind: "session", sessionId: "s1" }, scopes: null }
  return { actor, settings, allowed: actions.map(action => isWorkspaceActionAllowed(actor, settings, action)) }
}))
const entitlements = ["free", "basic", "business", "enterprise"].flatMap(plan => [{}, { "restrict-invitations": true, hipaa: false, unknown: true }].map(overrides => ({ plan, overrides, expected: resolveEntitlements(plan, overrides) })))
function normalize(input) {
  let domain = input.trim().toLowerCase().replace(/\.$/, "")
  if (/[\/@:]/.test(domain)) return null
  domain = domainToASCII(domain)
  if (!domain || domain.length > 253 || domain.split(".").length < 2 || domain.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null
  return domain
}
const domains = ["Example.COM.", " bücher.de ", "a.b", "localhost", "-bad.com", "bad-.com", "a..b", "https://a.com", "a@b.com", "a.com:443", "a\\b.com", "☃.net", "127.0.0.1", "123.456", "a." + "b".repeat(64), "a.com..", "a%2eb.com", "\u0085example.com", "\ufeffexample.com\ufeff", "\u2000example.com\u2000"].map(input => ({ input, expected: normalize(input) }))
const day = 86400000, origin = Date.parse("2026-11-01T00:00:00Z")
const at = n => new Date(origin + n * day).toISOString()
const base = { plan: "plus", status: "active", source: "polar", sourceReference: "sub-1", providerEnvironment: "sandbox", currentPeriodStart: at(0), currentPeriodEnd: at(30), paidActivatedAt: at(0) }
const states = [null,
  ...["free", "starter", "basic", "plus", "business", "enterprise", "unknown"].flatMap(plan => ["active", "trialing", "past_due", "canceled", "unknown"].flatMap(status => [undefined, "internal", "polar"].map(source => ({ ...base, plan, status, source })))),
  ...["terminatedAt", "unsupportedPauseAt", "paidActivatedAt", "currentPeriodStart", "currentPeriodEnd", "cancellationPeriodEnd"].flatMap(key => [null, at(-1), at(0), at(14), at(30), "invalid"].map(value => ({ ...base, [key]: value }))),
  ...[null, at(14), at(30)].map(cancellationPeriodEnd => ({ ...base, status: "canceled", cancelAtPeriodEnd: true, cancellationPeriodEnd })),
  ...[6, 7, 8].flatMap(days => [at(-1), at(0), at(1), null].map(paidActivatedAt => ({ ...base, status: "past_due", paidActivatedAt, paymentFailedAt: at(0), graceExpiresAt: at(days) }))),
  ...[13, 14, 15].flatMap(days => [null, "trial-1", "wrong"].flatMap(sourceReference => [null, "sandbox"].map(providerEnvironment => ({ ...base, source: "forge-trial", status: "trialing", trialRedemptionId: "trial-1", sourceReference, providerEnvironment, paidActivatedAt: null, currentPeriodEnd: at(days) })))),
]
const refund = { orderId: "order-1", subscriptionId: "sub-1", environment: "sandbox", start: at(0), end: at(30), refundedAt: at(2) }
for (const kind of [undefined, "upgrade"]) for (const subscriptionId of ["sub-1", "other"]) for (const environment of ["sandbox", "production"]) for (const start of [at(0), at(30)]) for (const paidUpgradeOrderId of [null, "order-1", "other"]) for (const starterOrderId of [null, "starter-1"]) {
  states.push({ ...base, paidUpgradeOrderId, refundedPeriods: [{ ...refund, kind, subscriptionId, environment, start, starterOrderId, basePeriodStart: at(0), basePeriodEnd: at(30) }] })
}
const dateKeys = ["terminatedAt", "unsupportedPauseAt", "paidActivatedAt", "paymentFailedAt", "graceExpiresAt", "currentPeriodStart", "currentPeriodEnd", "cancellationPeriodEnd"]
const subscriptions = states.flatMap(state => [-1, 0, 6, 7, 13, 14, 29, 30].map(n => {
  const converted = state && { ...state }
  if (converted) for (const key of dateKeys) if (converted[key] != null) converted[key] = new Date(converted[key])
  return { state, now: at(n), expected: subscriptionAccess(converted, new Date(at(n))) }
}))
export const security = { defaults, actions, policies, entitlements, domains, subscriptions }
