// Actual owning checkout/portal orchestration with injected authority/provider
// boundaries. No credentials, database, or network I/O is used by this exporter.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import * as authorization from '../apps/forge/src/application/authorization.ts'
mock.module('@tanstack/react-start/server-only', () => ({}))
mock.module('@/application/authorization', () => authorization)
const { PolarBillingProvider } = await import('../apps/forge/src/application/billing/polar-billing-provider.server.ts')
const copy = value => JSON.parse(JSON.stringify(value))
const config = {
  enabled: true, environment: 'sandbox', accessToken: 'fixture-token', webhookSecret: 'fixture-secret',
  paidProducts: {
    starter: { usd: '00000000-0000-4000-8000-000000000001', eur: '00000000-0000-4000-8000-000000000002' },
    plus: { usd: '00000000-0000-4000-8000-000000000003', eur: '00000000-0000-4000-8000-000000000004' },
  },
  appUrl: 'https://forge.example.test',
}
const actor = { userId: 'alice', workspaceId: 'workspace-a', workspaceRole: 'owner', authentication: { kind: 'session', sessionId: 's' }, scopes: null }
const context = { workspaceId: actor.workspaceId, billableMembers: 3, billingCountry: 'FR' }
const hosted = { id: 'checkout-not-a-uuid', url: 'https://polar.sh/checkout/fixture' }
function product(plan = 'starter', currency = 'eur') {
  const id = config.paidProducts[plan][currency]
  return { id, is_archived: false, is_recurring: true, recurring_interval: 'month', recurring_interval_count: 1, prices: [{
    id: '00000000-0000-4000-8000-000000000005', product_id: id, is_archived: false,
    source: 'catalog', amount_type: 'seat_based', price_currency: currency, tax_behavior: 'exclusive',
    seat_tiers: { minimum_seats: 1, maximum_seats: null, seat_tier_type: 'volume', tiers: [{ min_seats: 1, max_seats: null, price_per_seat: plan === 'plus' ? 1600 : 1000 }] },
  }] }
}
const cases = []
async function add(name, kind, patch = {}) {
  const input = copy({
    name, kind, actor, plan: 'starter', contexts: [{ value: context }, { value: context }],
    responses: kind === 'checkout' ? [{ kind: 'product', value: product() }, { kind: 'checkout', value: hosted }] : [{ kind: 'portal', value: { customer_portal_url: 'https://polar.sh/portal/fixture' } }],
    ...patch,
  })
  const trace = []; let contextIndex = 0, responseIndex = 0
  const resolve = async current => {
    trace.push({ kind: 'context', actor: copy(current) })
    const step = input.contexts[contextIndex++]
    if (!step) throw Error('UNEXPECTED_CONTEXT')
    if (step.error) throw Error(step.error)
    return copy(step.value)
  }
  const perform = async (kind, data) => {
    trace.push({ kind, ...copy(data) })
    const step = input.responses[responseIndex++]
    if (!step || step.kind !== kind) throw Error('UNEXPECTED_PROVIDER_OPERATION')
    if (step.error) throw Error(step.error)
    return copy(step.value)
  }
  const provider = new PolarBillingProvider(config, resolve, {
    products: { get: id => perform('product', { id }) },
    checkouts: { create: body => perform('checkout', { body }) },
    customerSessions: { create: body => perform('portal', { body }) },
  })
  try {
    const output = await (kind === 'checkout' ? provider.createCheckout(input.actor, input.plan) : provider.createPortal(input.actor))
    cases.push({ ...input, trace, valid: true, output: copy(output) })
  } catch (error) {
    const code = error.name === 'ZodError' || error instanceof TypeError ? 'INVALID_BILLING_INPUT' : (error.code ?? error.message)
    cases.push({ ...input, trace, valid: false, error: code })
  }
}
for (const plan of ['starter', 'plus']) for (const [billingCountry, currency] of [['FR', 'eur'], ['US', 'usd'], ['GB', 'eur'], ['CH', 'eur'], ['NO', 'eur'], ['DE', 'eur'], ['JP', 'usd'], [' fr ', 'eur']]) for (const members of [1, 3, 101]) {
  const ctx = { ...context, billingCountry, billableMembers: members, currency: currency === 'eur' ? 'usd' : 'eur', trialEligible: true, trialDays: 365 }
  await add(`${plan}/${billingCountry}/${members}`, 'checkout', { plan, contexts: [{ value: ctx }, { value: ctx }], responses: [{ kind: 'product', value: product(plan, currency) }, { kind: 'checkout', value: hosted }] })
}
for (const kind of ['checkout', 'portal']) {
  await add(`${kind}/baseline`, kind)
  for (const workspaceRole of ['owner', 'admin', 'member', 'guest', '', ' member, admin ']) for (const authentication of [actor.authentication, { kind: 'apiKey', credentialId: 'k' }, { kind: 'agent', runId: 'r', tokenId: 't' }, { kind: 'loop', loopId: 'l', runId: 'r' }])
    await add(`${kind}/actor/${workspaceRole}/${authentication.kind}`, kind, { actor: { ...actor, workspaceRole, authentication } })
  for (const field of ['workspaceId', 'userId']) for (const value of ['', ' ', '\uFEFF']) await add(`${kind}/empty-identity/${field}/${JSON.stringify(value)}`, kind, { actor: { ...actor, [field]: value } })
  for (const phase of [0, 1]) {
    const changed = copy([{ value: context }, { value: context }]); changed[phase] = { error: 'BILLING_ACTOR_REVOKED' }
    await add(`${kind}/revoked/${phase}`, kind, { contexts: changed })
    changed[phase] = { value: { ...context, workspaceId: 'workspace-other' } }
    await add(`${kind}/other-workspace/${phase}`, kind, { contexts: changed })
  }
  const response = kind === 'checkout' ? [{ kind: 'product', value: product() }, { kind, error: 'BILLING_PROVIDER_UNAVAILABLE' }] : [{ kind, error: 'BILLING_PROVIDER_UNAVAILABLE' }]
  await add(`${kind}/provider-failure`, kind, { responses: response })
  for (const url of ['https://polar.sh', 'HTTPS://POLAR.SH:443/a/../checkout?q=hello%20world#done', 'https://polar.sh/語 空', 'https://@polar.sh/', 'https://:@polar.sh/', 'https://user@polar.sh/', 'https://:pass@polar.sh/', 'http://polar.sh/', 'javascript:alert(1)', '/checkout', '', 'https://[::1]/', 'https://polar.sh:444/']) {
    const value = kind === 'checkout' ? { id: hosted.id, url } : { customer_portal_url: url }
    await add(`${kind}/hosted-url/${url}`, kind, { responses: kind === 'checkout' ? [{ kind: 'product', value: product() }, { kind, value }] : [{ kind, value }] })
  }
}
for (const plan of ['free', 'enterprise', '', 'STARTER']) await add(`unsupported-plan/${plan}`, 'checkout', { plan })
for (const billableMembers of [0, -1, 1.5, null, '3', true, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Math.floor(Number.MAX_SAFE_INTEGER / 1000), Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1])
  await add(`quantity/${JSON.stringify(billableMembers)}`, 'checkout', { contexts: [{ value: { ...context, billableMembers } }, { value: { ...context, billableMembers } }] })
for (const billingCountry of [null, '', 'ZZ', 'UK', 42, {}, []]) await add(`invalid-country/${JSON.stringify(billingCountry)}`, 'checkout', { contexts: [{ value: { ...context, billingCountry } }] })
for (const changed of [{ billableMembers: 4 }, { billableMembers: 0 }, { billableMembers: '3' }, { billingCountry: 'US' }, { billingCountry: 'DE' }, { billingCountry: null }, { billingCountry: ' fr ' }, { trialDays: 999, currency: 'usd' }])
  await add(`changed-checkout-context/${JSON.stringify(changed)}`, 'checkout', { contexts: [{ value: context }, { value: { ...context, ...changed } }] })
// Portal validates authority/workspace only; country and seat count are not a
// condition of viewing an existing customer's billing portal.
await add('portal/irrelevant-fields', 'portal', { contexts: [{ value: { workspaceId: actor.workspaceId } }, { value: { workspaceId: actor.workspaceId, billableMembers: 0, billingCountry: null } }] })
for (const field of ['billableMembers', 'billingCountry']) {
  const missing = copy(context); delete missing[field]
  await add(`missing-context/${field}`, 'checkout', { contexts: [{ value: missing }] })
}
for (const change of ['archived', 'annual', 'wrong-unit-price', 'wrong-currency', 'duplicate-price', 'inclusive-tax', 'capped-seats', 'missing-max-seats', 'wrong-product', 'shared-currencies', 'shared-invalid-price', 'archived-invalid-price']) {
  const p = product(), price = p.prices[0]
  if (change === 'archived') p.is_archived = true
  if (change === 'annual') p.recurring_interval = 'year'
  if (change === 'wrong-unit-price') price.seat_tiers.tiers[0].price_per_seat = 900
  if (change === 'wrong-currency') price.price_currency = 'usd'
  if (change === 'duplicate-price') p.prices.push(copy(price))
  if (change === 'inclusive-tax') price.tax_behavior = 'inclusive'
  if (change === 'capped-seats') price.seat_tiers.maximum_seats = 5
  if (change === 'missing-max-seats') delete price.seat_tiers.maximum_seats
  if (change === 'wrong-product') p.id = config.paidProducts.plus.eur
  if (['shared-currencies', 'shared-invalid-price', 'archived-invalid-price'].includes(change)) {
    const extra = { ...copy(price), id: '00000000-0000-4000-8000-000000000006', price_currency: 'usd' }
    if (change === 'shared-invalid-price') extra.seat_tiers.tiers[0].price_per_seat = 5
    if (change === 'archived-invalid-price') { extra.is_archived = true; extra.price_currency = 'bad' }
    p.prices.push(extra)
  }
  await add(`catalog/${change}`, 'checkout', { responses: [{ kind: 'product', value: p }, { kind: 'checkout', value: hosted }] })
}
await add('catalog/provider-failure', 'checkout', { responses: [{ kind: 'product', error: 'BILLING_PROVIDER_UNAVAILABLE' }] })
for (const value of [{ url: hosted.url }, { id: null, url: hosted.url }, { id: 123, url: hosted.url }]) await add(`checkout/id-passthrough/${JSON.stringify(value)}`, 'checkout', { responses: [{ kind: 'product', value: product() }, { kind: 'checkout', value }] })
const output = JSON.stringify({ config, cases }, null, 2) + '\n'
const file = new URL('../rust/crates/forge-core/data/billing-checkout-reference.json', import.meta.url)
if (process.argv.includes('--check')) {
  if (readFileSync(file, 'utf8') !== output) throw Error('Billing checkout source reference changed')
} else writeFileSync(file, output)
console.log(`Billing checkout reference: ${cases.length} owning-source cases`)
