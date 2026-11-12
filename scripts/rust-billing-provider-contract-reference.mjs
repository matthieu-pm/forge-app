// Owning provider-boundary validators, with persistence imports replaced by sinks.
// Source observations only: no provider requests, credentials, database or mutations.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
mock.module('@tanstack/react-start/server-only', () => ({}))
mock.module(new URL('../apps/forge/src/application/billing/subscription-reconciliation.server.ts', import.meta.url).pathname, () => ({
  applyVerifiedSubscriptionSnapshot: () => { throw Error('Provider contract fixture cannot write state') },
}))
const { verifyPaidCatalog } = await import('../apps/forge/src/application/billing/polar-paid-catalog.ts')
const { verifiedPolarSubscriptionSnapshot } = await import('../apps/forge/src/application/billing/polar-subscription-reconciliation.server.ts')
const json = value => JSON.parse(JSON.stringify(value))
const cases = []
const config = {
  enabled: true, environment: 'sandbox', accessToken: 'fixture-only', webhookSecret: 'fixture-only', appUrl: 'https://forge.test',
  paidProducts: {
    starter: { eur: '11111111-1111-4111-8111-111111111111', usd: '11111111-1111-4111-8111-111111111111' },
    plus: { eur: '22222222-2222-4222-8222-222222222222', usd: '22222222-2222-4222-8222-222222222222' },
  },
}
const priceId = 'abcdefab-cdef-4abc-8def-abcdefabcdef'
const subId = '33333333-3333-4333-8333-333333333333'
const start = '2027-01-01T00:00:00.000Z', end = '2027-02-01T00:00:00.000Z', updated = '2027-01-20T00:00:00.000Z'
function add(kind, input, selectedConfig = config) {
  const item = { kind, input: json(input), ...(selectedConfig === config ? {} : {config: json(selectedConfig)}) }
  try {
    const output = kind === 'catalog'
      ? verifyPaidCatalog(input.product, input.selection)
      : verifiedPolarSubscriptionSnapshot(selectedConfig, input.workspaceId, input.subscriptionId, input.subscription)
    cases.push({ ...item, valid: true, output: json(output) })
  } catch (error) {
    const code = ['ZodError', 'TypeError'].includes(error.name) ? 'INVALID_BILLING_INPUT' : error.message
    cases.push({ ...item, valid: false, error: code })
  }
}
function product(plan = 'starter', currency = 'eur') {
  const id = config.paidProducts[plan][currency]
  return {
    id, is_archived: false, is_recurring: true, recurring_interval: 'month', recurring_interval_count: 1,
    prices: [{
      id: priceId, is_archived: false, amount_type: 'seat_based', source: 'catalog', product_id: id,
      price_currency: currency, tax_behavior: 'exclusive',
      seat_tiers: {minimum_seats: 1, maximum_seats: null, seat_tier_type: 'volume', tiers: [{min_seats: 1, max_seats: null, price_per_seat: plan === 'starter' ? 1000 : 1600}]},
    }],
  }
}
function catalog(value = product(), selection = {productId: value.id, plan: 'starter', currency: 'eur'}) {
  add('catalog', {product: value, selection})
}
for (const plan of ['starter', 'plus']) for (const currency of ['eur', 'usd']) {
  const one = product(plan, currency), selection = {productId: one.id, plan, currency}
  catalog(one, selection)
  const other = product(plan, currency === 'eur' ? 'usd' : 'eur').prices[0]
  other.id = subId
  catalog({...one, prices: [...one.prices, other]}, selection)
  // An inactive legacy price can have an obsolete currency/shape.
  catalog({...one, prices: [...one.prices, {is_archived: true, price_currency: 'gbp'}]}, selection)
  catalog({...one, prices: [...one.prices, {...other, id: 'not-selected-id'}]}, selection)
}
const base = product(), selection = {productId: base.id, plan: 'starter', currency: 'eur'}
for (const field of ['id', 'is_archived', 'is_recurring', 'recurring_interval', 'recurring_interval_count', 'prices']) {
  for (const value of [undefined, null, false, true, 0, 1, 'bad', [], {}]) catalog({...base, [field]: value}, selection)
}
for (const field of ['productId', 'plan', 'currency']) for (const value of [undefined, null, false, 0, 'bad', '', 'STARTER', 'USD']) catalog(base, {...selection, [field]: value})
for (const field of ['id', 'is_archived', 'amount_type', 'source', 'product_id', 'price_currency', 'tax_behavior', 'seat_tiers']) {
  for (const value of [undefined, null, false, 0, 1, 'bad', [], {}]) catalog({...base, prices: [{...base.prices[0], [field]: value}]})
}
for (const field of ['minimum_seats', 'maximum_seats', 'seat_tier_type', 'tiers']) {
  for (const value of [undefined, null, false, 0, 1, 'bad', [], {}]) {
    catalog({...base, prices: [{...base.prices[0], seat_tiers: {...base.prices[0].seat_tiers, [field]: value}}]})
  }
}
for (const field of ['min_seats', 'max_seats', 'price_per_seat']) {
  for (const value of [undefined, null, false, 0, 1, 1000, 1600, Number.MAX_SAFE_INTEGER, '1000']) {
    catalog({...base, prices: [{...base.prices[0], seat_tiers: {...base.prices[0].seat_tiers, tiers: [{...base.prices[0].seat_tiers.tiers[0], [field]: value}]}}]})
  }
}
for (const tierType of [undefined, 'volume', 'graduated']) for (const max of [undefined, null]) {
  catalog({...base, prices: [{...base.prices[0], seat_tiers: {...base.prices[0].seat_tiers, seat_tier_type: tierType, tiers: [{min_seats: 1, max_seats: max, price_per_seat: 1000}]}}]})
}
for (const prices of [[], [null], [false], [0], [{}], [base.prices[0], null], [base.prices[0], {...base.prices[0], id: subId}], [{...base.prices[0], is_archived: true}], [{...base.prices[0], price_currency: 'usd'}]]) catalog({...base, prices})
for (const tiers of [[], [null], [false], [0], [{}], [base.prices[0].seat_tiers.tiers[0], base.prices[0].seat_tiers.tiers[0]]]) {
  catalog({...base, prices: [{...base.prices[0], seat_tiers: {...base.prices[0].seat_tiers, tiers}}]})
}
// Every active currency is checked, even when another currency is requested.
catalog({...base, prices: [...base.prices, {...base.prices[0], price_currency: 'usd', tax_behavior: 'inclusive'}]})
catalog({...base, prices: [...base.prices, {...base.prices[0], price_currency: 'usd', seat_tiers: {...base.prices[0].seat_tiers, tiers: [{min_seats: 1, price_per_seat: 999}]}}]})
catalog({...base, prices: [{...base.prices[0], id: priceId.toUpperCase()}]})
catalog({...base, id: priceId, prices: [{...base.prices[0], product_id: priceId}]}, {...selection, productId: priceId})
catalog({...base, id: priceId, prices: [{...base.prices[0], product_id: priceId}]}, {...selection, productId: priceId.toUpperCase()})
catalog({...base, id: priceId.toUpperCase(), prices: [{...base.prices[0], product_id: priceId.toUpperCase()}]}, {...selection, productId: priceId.toUpperCase()})
catalog({...base, unknown: 'ignored'})

const subscription = {
  id: subId, customer: {external_id: 'forge:workspace:workspace'}, product_id: config.paidProducts.starter.eur,
  currency: 'eur', status: 'active', modified_at: updated, created_at: start,
  current_period_start: start, current_period_end: end, recurring_interval: 'month', recurring_interval_count: 1,
  past_due_at: null, cancel_at_period_end: false, ends_at: null, ended_at: null,
  pause_at_period_end: false, paused_at: null, resumes_at: null,
}
function snapshot(value = subscription, selectedConfig = config, input = {}) {
  add('snapshot', {workspaceId: 'workspace', subscriptionId: subId, subscription: value, ...input}, selectedConfig)
}
const pauseStates = [
  {pause_at_period_end: false, paused_at: null},
  {pause_at_period_end: true, paused_at: null},
  {pause_at_period_end: false, paused_at: '2027-01-15T00:00:00Z'},
  {pause_at_period_end: true, paused_at: '2027-01-25T00:00:00Z'},
]
for (const status of ['active', 'past_due', 'canceled', 'unpaid', 'paused']) {
  for (const cancel_at_period_end of [false, true]) for (const pause of pauseStates) {
    for (const resumes_at of [null, '2027-01-14T00:00:00Z', '2027-02-01T00:00:00Z']) {
      for (const ended_at of [null, '2027-01-10T00:00:00Z', '2027-01-25T00:00:00Z']) {
        snapshot({...subscription, status, cancel_at_period_end, ...pause, resumes_at, ended_at, past_due_at: '2027-01-12T00:00:00Z'})
      }
    }
  }
}
for (const field of Object.keys(subscription)) {
  for (const value of [undefined, null, false, 0, '', 'bad', {}, []]) snapshot({...subscription, [field]: value})
}
for (const customer of [{}, {external_id: ''}, {external_id: 'forge:workspace:other'}, {external_id: 'forge:workspace:workspace', other: true}]) snapshot({...subscription, customer})
for (const status of ['trialing', 'incomplete', 'incomplete_expired', 'cancelled', 'ACTIVE']) snapshot({...subscription, status})
for (const plan of ['starter', 'plus']) for (const currency of ['eur', 'usd']) for (const environment of ['sandbox', 'production']) {
  snapshot({...subscription, product_id: config.paidProducts[plan][currency], currency}, {...config, environment})
}
const duplicated = {...config, paidProducts: {...config.paidProducts, plus: config.paidProducts.starter}}
snapshot(subscription, duplicated)
snapshot(subscription, {...config, paidProducts: {...config.paidProducts, starter: {...config.paidProducts.starter, eur: subId}}})
for (const modified_at of [undefined, null]) {
  for (const created_at of [start, '2027-01-01T01:00:00+01:00', undefined, null, 'bad']) snapshot({...subscription, modified_at, created_at})
}
const dates = ['2027-01-01T01:00:00+01:00', '2027-01-20T00:00:00.123456Z', '2027-02-30T12:00:00Z', '2028-02-29T12:00:00Z', '2027-01-01T12:00Z', '2027-01-01t12:00:00Z', '2027-01-01T12:00:00z', '2027-01-01T24:00:00Z', '2027-01-01T12:00:60Z', '2027-01-01T12:00:00+23:59', '2027-01-01T12:00:00+24:00', '2027-01-01T12:00:00', '2027-01-01T12:00:00+0100']
for (const field of ['modified_at', 'current_period_start', 'current_period_end', 'paused_at', 'resumes_at', 'past_due_at']) {
  for (const date of dates) snapshot({...subscription, status: field === 'past_due_at' ? 'past_due' : 'active', pause_at_period_end: field === 'resumes_at', [field]: date})
}
for (const ends_at of [undefined, null, '', false, 0, end, '2027-02-01T01:00:00+01:00', start, 'bad']) {
  for (const status of ['active', 'canceled', 'unpaid']) snapshot({...subscription, cancel_at_period_end: true, status, ends_at})
}
for (const value of [null, {}, [], false]) {
  add('snapshot', {workspaceId: 'workspace', subscriptionId: subId, subscription: value})
  add('catalog', {product: value, selection})
}
// These are observations, not the durable projection's period/order validator.
snapshot({...subscription, current_period_start: end, current_period_end: start})
snapshot({...subscription, unknown: 'ignored', past_due_at: 'ignored for active'})
snapshot({...subscription, id: priceId.toUpperCase()}, config, {subscriptionId: priceId.toUpperCase()})
snapshot({...subscription, id: priceId}, config, {subscriptionId: priceId.toUpperCase()})
snapshot({...subscription, id: 'not-a-uuid'}, config, {subscriptionId: 'not-a-uuid'})
snapshot({...subscription, customer: {external_id: 'forge:workspace: '}}, config, {workspaceId: ' '})
const actual = JSON.parse(readFileSync(new URL('../apps/forge/src/application/billing/fixtures/polar-sandbox-paid-starter.json', import.meta.url), 'utf8'))
snapshot(actual.subscription, {...config, paidProducts: {...config.paidProducts, starter: {eur: actual.subscription.product_id, usd: actual.subscription.product_id}}}, {workspaceId: actual.provenance.workspaceId, subscriptionId: actual.subscription.id})

const path = new URL('../rust/crates/forge-core/data/billing-provider-contract-reference.json', import.meta.url)
const output = JSON.stringify({config, cases}, null, 2) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== output) throw Error('Billing provider contract fixtures are stale')
} else writeFileSync(path, output)
console.log(`Billing provider contract source fixtures: ${cases.length}`)
