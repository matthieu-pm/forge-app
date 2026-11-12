// Actual owning renewal adapters with stateful provider/store probes. No I/O.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import * as authorization from '../apps/forge/src/application/authorization.ts'
mock.module('@tanstack/react-start/server-only', () => ({}))
mock.module('@/application/authorization', () => authorization)
for (const [file, name] of [['subscription-reconciliation.server.ts', 'applyVerifiedSubscriptionSnapshot'], ['renewal-currency-request.server.ts', 'recordVerifiedRenewalCurrencyRequest']]) mock.module(new URL('../apps/forge/src/application/billing/' + file, import.meta.url).pathname, () => ({ [name]() { throw Error('Unexpected persistence') } }))
const { PolarSubscriptionCancellation } = await import('../apps/forge/src/application/billing/polar-subscription-cancellation.server.ts')
const { PolarRenewalCurrencyPlanner } = await import('../apps/forge/src/application/billing/polar-renewal-currency.server.ts')
const { PolarUpgradeRefundRenewal } = await import('../apps/forge/src/application/billing/polar-upgrade-refund-renewal.server.ts')
const copy = value => JSON.parse(JSON.stringify(value))
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const sub = id(99), key = 'abcdefab-cdef-4def-8def-abcdefabcdef', start = '2027-01-01T00:00:00.000Z', end = '2027-02-01T00:00:00.000Z', now = '2027-01-15T12:00:00.000Z'
const config = { enabled: true, environment: 'sandbox', accessToken: 'fixture-token', webhookSecret: 'fixture-secret', appUrl: 'https://forge.test', paidProducts: { starter: { usd: id(1), eur: id(2) }, plus: { usd: id(3), eur: id(4) } } }
const actor = { workspaceId: 'w1', userId: 'owner', workspaceRole: 'owner', scopes: null, authentication: { kind: 'session', sessionId: 'fixture' } }
const identity = { workspaceId: 'w1', environment: 'sandbox', subscriptionId: sub, orderId: key }
const context = { workspaceId: 'w1', subscriptionId: sub, projectedPlan: 'plus', billableMembers: 3, refundedUpgrade: false }
const refundContext = { status: 'required', start, end, revision: 'a'.repeat(64) }
const pending = { id: id(98), created_at: start, modified_at: start, applies_at: end, product_id: null, seats: 5, units: null }
const subscription = { id: sub, product_id: config.paidProducts.plus.usd, currency: 'usd', amount: 4800, seats: 3, customer: { external_id: 'forge:workspace:w1', billing_address: { country: 'FR' } }, status: 'active', recurring_interval: 'month', recurring_interval_count: 1, modified_at: start, created_at: start, current_period_start: start, current_period_end: end, past_due_at: null, cancel_at_period_end: false, ends_at: null, ended_at: null, pause_at_period_end: false, paused_at: null, resumes_at: null, pending_update: pending }
const without = (value, key) => { const result = copy(value); delete result[key]; return result }
const cases = []
async function add(name, kind, patch = {}) {
  const input = copy({ name, kind, actor, identity, requestId: key, state: subscription, contexts: [{ value: context }], reads: [{ value: refundContext }], gets: [], updates: [], projects: [], records: [], confirms: [], clocks: [now], attempts: 1, ...patch })
  let current = copy(input.state)
  const trace = [], indexes = {}
  const step = name => { const entries = input[name]; const index = indexes[name] ?? 0; indexes[name] = index + 1; return entries.length ? entries[Math.min(index, entries.length - 1)] : {} }
  const result = (step, fallback) => { if (step.error) throw Error(step.error); return copy(Object.hasOwn(step, 'value') ? step.value : fallback) }
  const applyPatch = step => { if (step.patch) current = { ...current, ...copy(step.patch) }; for (const key of step.remove ?? []) delete current[key] }
  const resolve = async candidate => { trace.push({ kind: 'context', actor: copy(candidate) }); return result(step('contexts'), context) }
  const get = async id => { trace.push({ kind: 'get', id }); const next = step('gets'); applyPatch(next); return result(next, current) }
  const update = async (id, body) => {
    trace.push({ kind: 'update', id, body: copy(body) }); const next = step('updates')
    if (next.auto !== false) {
      if (body.cancel_at_period_end === true) current = { ...current, cancel_at_period_end: true, ends_at: current.current_period_end, modified_at: now }
      if (body.product_id) current = { ...current, pending_update: { ...(current.pending_update ?? { ...pending, seats: null }), product_id: body.product_id }, modified_at: now }
    }
    applyPatch(next); return result(next, current)
  }
  const project = async event => { trace.push({ kind: 'project', input: copy(event) }); return result(step('projects'), { outcome: 'applied', replayed: false }) }
  const record = async (candidate, value) => { trace.push({ kind: 'record', actor: copy(candidate), input: copy(value) }); return result(step('records'), { status: 'requires-checkout', providerChangeScheduled: false }) }
  const read = async value => { trace.push({ kind: 'read', input: copy(value) }); return result(step('reads'), refundContext) }
  const confirm = async (value, proof) => { trace.push({ kind: 'confirm', input: copy(value), proof: copy(proof) }); return result(step('confirms'), { status: proof.status, replayed: false }) }
  const clock = () => { const values = input.clocks, index = indexes.clock ?? 0; indexes.clock = index + 1; const value = values[Math.min(index, values.length - 1)]; trace.push({ kind: 'clock', value }); return new Date(value) }
  const service = kind === 'cancel' ? new PolarSubscriptionCancellation(config, resolve, { subscriptions: { get, update } }, project) : kind === 'currency' ? new PolarRenewalCurrencyPlanner(config, resolve, get, record, clock, project) : new PolarUpgradeRefundRenewal(config, { get, update }, { read, confirm, project }, clock)
  const results = []
  for (let attempt = 0; attempt < input.attempts; attempt++) {
    try {
      const output = await (kind === 'cancel' ? service.schedule(input.actor) : kind === 'currency' ? service.request(input.actor, input.requestId) : service.reconcile(input.identity))
      results.push({ valid: true, output: copy(output) })
    } catch (error) {
      results.push({ valid: false, error: ['ZodError', 'TypeError', 'RangeError'].includes(error.name) ? 'INVALID_BILLING_INPUT' : (error.code ?? error.message) })
    }
  }
  cases.push({ ...input, trace, results })
}
for (const kind of ['cancel', 'currency', 'refund']) {
  await add(`${kind}/baseline`, kind)
  await add(`${kind}/replay`, kind, { attempts: 2 })
  await add(`${kind}/get-failure`, kind, { gets: [{ error: 'BILLING_PROVIDER_UNAVAILABLE' }] })
  await add(`${kind}/wrong-customer`, kind, { state: { ...subscription, customer: { external_id: 'other' } } })
  for (const patch of [{ status: 'trialing' }, { currency: 'eur' }, { id: id(100) }, { recurring_interval: 'year' }, { modified_at: 'bad' }, { paused_at: undefined }, { resumes_at: undefined }, { pause_at_period_end: true }, { status: 'paused', paused_at: start }, { status: 'unpaid', modified_at: now }, { status: 'canceled', cancel_at_period_end: false, ended_at: now, modified_at: now }]) await add(`${kind}/provider/${JSON.stringify(patch)}`, kind, { state: { ...subscription, ...patch } })
  for (const error of ['BILLING_PERSISTENCE_UNAVAILABLE']) await add(`${kind}/restricted-project-failure`, kind, { state: { ...subscription, pause_at_period_end: true }, projects: [{ error }] })
}
for (const kind of ['cancel', 'currency']) {
  for (const workspaceRole of ['owner', 'admin', ' member, admin ', 'member', 'guest', '']) for (const authentication of [actor.authentication, { kind: 'apiKey', credentialId: 'key' }]) await add(`${kind}/actor/${workspaceRole}/${authentication.kind}`, kind, { actor: { ...actor, workspaceRole, authentication } })
  for (const phase of [0, 1]) {
    for (const value of [null, { ...context, workspaceId: 'other' }, { ...context, subscriptionId: id(98) }]) {
      const contexts = [{ value: context }, { value: context }]; contexts[phase] = { value }
      await add(`${kind}/context/${phase}/${JSON.stringify(value)}`, kind, { contexts })
    }
    const contexts = [{ value: context }, { value: context }]; contexts[phase] = { error: 'BILLING_ACTOR_REVOKED' }
    await add(`${kind}/revoked/${phase}`, kind, { contexts })
  }
  await add(`${kind}/invalid-subscription`, kind, { contexts: [{ value: { ...context, subscriptionId: 'bad' } }] })
}
await add('cancel/already-scheduled', 'cancel', { state: { ...subscription, cancel_at_period_end: true, ends_at: end } })
await add('cancel/completed', 'cancel', { state: { ...subscription, status: 'canceled', ended_at: end, modified_at: end, ends_at: end } })
await add('cancel/ignored-patch-body', 'cancel', { updates: [{ value: null }] })
await add('cancel/not-confirmed', 'cancel', { updates: [{ auto: false }] })
await add('cancel/moved-boundary', 'cancel', { updates: [{ patch: { current_period_end: '2027-03-01T00:00:00.000Z', ends_at: '2027-03-01T00:00:00.000Z' } }] })
await add('cancel/terminal-moved-boundary', 'cancel', { updates: [{ patch: { status: 'unpaid', ended_at: now, current_period_end: '2027-03-01T00:00:00.000Z' } }] })
await add('cancel/stale-projection', 'cancel', { projects: [{ value: { outcome: 'stale' } }] })
await add('cancel/lost-response-retry', 'cancel', { attempts: 2, updates: [{ error: 'BILLING_PROVIDER_UNAVAILABLE' }] })
await add('cancel/audit-retry', 'cancel', { attempts: 2, projects: [{ error: 'BILLING_PERSISTENCE_UNAVAILABLE' }, { value: { outcome: 'applied', replayed: true } }] })
await add('cancel/pause-before-patch', 'cancel', { state: { ...subscription, pause_at_period_end: true } })
for (const candidateKey of ['bad', key.toUpperCase()]) await add(`currency/request/${candidateKey}`, 'currency', { requestId: candidateKey })
for (const patch of [{ status: 'past_due', past_due_at: now }, { cancel_at_period_end: true }, { ends_at: end }, { ends_at: '' }, { current_period_start: end }, { current_period_end: start }, { pending_update: null }]) await add(`currency/state/${JSON.stringify(patch)}`, 'currency', { state: { ...subscription, ...patch } })
for (const country of ['FR', 'US', ' fr ', 'ZZ', null, undefined, 0]) await add(`currency/country/${JSON.stringify(country)}`, 'currency', { state: { ...subscription, customer: { ...subscription.customer, billing_address: { country } } } })
for (const address of [null, undefined]) await add(`currency/address/${address}`, 'currency', { state: { ...subscription, customer: { ...subscription.customer, billing_address: address } } })
for (const kind of ['currency', 'refund']) {
  for (const patch of [{ units: 1 }, { units: undefined }, { product_id: id(50) }, { product_id: undefined }, { product_id: config.paidProducts.starter.usd }, { product_id: null, seats: null }, { product_id: null, seats: undefined }, { seats: 0 }, { seats: 1.5 }, { seats: '5' }, { seats: 7 }, { applies_at: start }, { applies_at: 'bad' }, { applies_at: undefined }, { applies_at: null }, { applies_at: '2027-02-01' }, { applies_at: '2027-02-01T02:00:00+02:00' }]) await add(`${kind}/pending/${JSON.stringify(patch)}`, kind, { state: { ...subscription, pending_update: { ...pending, ...patch } } })
  for (const value of [null, false, 0, {}]) await add(`${kind}/pending-value/${JSON.stringify(value)}`, kind, { state: { ...subscription, pending_update: value } })
  for (const clocks of [[start], [end], ['2026-12-31T23:59:59.999Z'], ['2027-01-31T23:59:59.999Z', end]]) await add(`${kind}/clock/${clocks}`, kind, { clocks })
}
for (const field of ['projectedPlan', 'refundedUpgrade', 'billableMembers']) for (const value of [undefined, null, false, 'starter', 9]) await add(`currency/fresh/${field}/${JSON.stringify(value)}`, 'currency', { contexts: [{ value: context }, { value: { ...context, [field]: value } }] })
await add('currency/member-count-changed', 'currency', { contexts: [{ value: context }, { value: { ...context, billableMembers: 7 } }] })
await add('currency/refunded-upgrade-with-downgrade', 'currency', { contexts: [{ value: { ...context, projectedPlan: 'starter', refundedUpgrade: true } }], state: { ...subscription, pending_update: { ...pending, product_id: config.paidProducts.starter.usd } } })
await add('currency/refunded-upgrade-without-downgrade', 'currency', { contexts: [{ value: { ...context, projectedPlan: 'starter', refundedUpgrade: true } }] })
await add('currency/ordinary-unreconciled-plan', 'currency', { contexts: [{ value: { ...context, projectedPlan: 'starter' } }] })
await add('currency/record-failure', 'currency', { records: [{ error: 'BILLING_PERSISTENCE_UNAVAILABLE' }] })
for (const phase of [0, 1]) for (const value of [null, { status: 'superseded' }, { status: 'terminated' }, { ...refundContext, revision: 'b'.repeat(64) }]) {
  const reads = [{ value: refundContext }, { value: refundContext }]; reads[phase] = { value }
  await add(`refund/read/${phase}/${JSON.stringify(value)}`, 'refund', { reads })
}
await add('refund/environment', 'refund', { identity: { ...identity, environment: 'production' } })
await add('refund/invalid-subscription', 'refund', { identity: { ...identity, subscriptionId: 'bad' } })
await add('refund/store-read-failure', 'refund', { reads: [{ error: 'BILLING_PERSISTENCE_UNAVAILABLE' }] })
await add('refund/already-starter', 'refund', { state: { ...subscription, product_id: config.paidProducts.starter.usd } })
await add('refund/already-scheduled', 'refund', { state: { ...subscription, pending_update: { ...pending, product_id: config.paidProducts.starter.usd } } })
await add('refund/no-pending', 'refund', { state: { ...subscription, pending_update: null } })
await add('refund/past-due', 'refund', { state: { ...subscription, status: 'past_due', past_due_at: now } })
for (const patch of [{ cancel_at_period_end: true }, { seats: 0 }, { seats: null }, { current_period_start: now }, { current_period_end: now }, { ends_at: '' }, { ended_at: '' }]) await add(`refund/state/${JSON.stringify(patch)}`, 'refund', { state: { ...subscription, ...patch } })
for (const field of ['ends_at', 'ended_at', 'paused_at']) await add(`refund/missing/${field}`, 'refund', { state: without(subscription, field) })
for (const patch of [{ amount: 999 }, { seats: 9 }, { current_period_end: '2027-03-01T00:00:00.000Z' }, { product_id: config.paidProducts.starter.usd }, { currency: 'eur', product_id: config.paidProducts.plus.eur }, { pending_update: { ...pending, product_id: config.paidProducts.starter.usd, seats: 9 } }, { status: 'unpaid', ended_at: now }, { pause_at_period_end: true }]) await add(`refund/after/${JSON.stringify(patch)}`, 'refund', { updates: [{ patch }] })
await add('refund/ignored-patch-body', 'refund', { updates: [{ value: null }] })
await add('refund/not-confirmed', 'refund', { updates: [{ auto: false }] })
await add('refund/lost-response-retry', 'refund', { attempts: 2, updates: [{ error: 'BILLING_PROVIDER_UNAVAILABLE' }] })
await add('refund/audit-retry', 'refund', { attempts: 2, confirms: [{ error: 'BILLING_PERSISTENCE_UNAVAILABLE' }, { value: { status: 'scheduled', replayed: true } }] })
await add('refund/second-get-failure', 'refund', { gets: [{}, { error: 'BILLING_PROVIDER_UNAVAILABLE' }] })
const file = new URL('../rust/crates/forge-core/data/billing-renewal-reference.json', import.meta.url), output = JSON.stringify({ config, cases }, null, 2) + '\n'
if (process.argv.includes('--check')) { if (readFileSync(file, 'utf8') !== output) throw Error('Billing renewal source reference changed') } else writeFileSync(file, output)
console.log(`Billing renewal reference: ${cases.length} owning-source cases`)
