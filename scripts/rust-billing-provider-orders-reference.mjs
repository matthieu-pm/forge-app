// Actual owning validators, with injected candidate lists and no provider/DB I/O.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
mock.module('@tanstack/react-start/server-only', () => ({}))
mock.module(new URL('../apps/forge/src/application/billing/subscription-refund.server.ts', import.meta.url).pathname, () => ({ applyVerifiedPeriodRefund() { throw Error('Fixture cannot persist refunds') } }))
mock.module(new URL('../apps/forge/src/application/billing/polar-upgrade-refund-renewal.server.ts', import.meta.url).pathname, () => ({ PolarUpgradeRefundRenewal: class {} }))
const { consistentPaidInvoiceAmounts, verifiedPaidUpgradeOrder, findPaidStarterBasis } = await import('../apps/forge/src/application/billing/polar-paid-upgrade.server.ts')
const { verifiedPolarPeriodRefund } = await import('../apps/forge/src/application/billing/polar-subscription-refund.server.ts')
const json = value => JSON.parse(JSON.stringify(value))
const orderId = 'abcdefab-cdef-4def-8def-abcdefabcdef'
const subscriptionId = '11111111-1111-4111-8111-111111111111'
const starter = '22222222-2222-4222-8222-222222222222'
const plus = '33333333-3333-4333-8333-333333333333'
const other = '44444444-4444-4444-8444-444444444444'
const start = '2027-01-01T00:00:00.000Z', end = '2027-02-01T00:00:00.000Z', created = '2027-01-15T12:00:00.000Z'
const context = { workspaceId: 'workspace', subscriptionId, productId: plus, currency: 'usd', periodStart: start, periodEnd: end, upgradeStart: created }
const config = { enabled: true, environment: 'sandbox', accessToken: 'fixture', webhookSecret: 'fixture', appUrl: 'https://forge.example', paidProducts: { starter: { eur: starter, usd: starter }, plus: { eur: plus, usd: plus } } }
const line = { proration: true, start_timestamp: created, end_timestamp: end, amount: 1000, tax_amount: 200 }
const paid = { id: orderId, customer: { external_id: 'forge:workspace:workspace' }, subscription_id: subscriptionId, product_id: plus, currency: 'usd', billing_reason: 'subscription_update', status: 'paid', paid: true, net_amount: 1000, tax_amount: 200, total_amount: 1200, due_amount: 1200, applied_balance_amount: 0, refunded_amount: 0, refunded_tax_amount: 0, created_at: created, modified_at: created, items: [line] }
const cycle = { ...paid, product_id: starter, billing_reason: 'subscription_cycle', created_at: start, items: [{ ...line, proration: false, start_timestamp: start }] }
const periodRefund = { ...cycle, status: 'refunded', refunded_amount: 1000, refunded_tax_amount: 200 }
const upgradeRefund = { ...paid, status: 'refunded', refunded_amount: 1000, refunded_tax_amount: 200 }
const cases = []
async function add(kind, order, patch = {}) {
  const input = json({ order, ...(kind === 'refund' ? { config, workspaceId: 'workspace', orderId } : kind === 'amounts' ? {} : { context }), ...patch })
  const candidate = json(input.order)
  try {
    let output
    if (kind === 'amounts') output = consistentPaidInvoiceAmounts(candidate)
    if (kind === 'upgrade' || kind === 'starter-basis') {
      const scope = { ...input.context, periodStart: new Date(input.context.periodStart), periodEnd: new Date(input.context.periodEnd), upgradeStart: new Date(input.context.upgradeStart) }
      if (kind === 'upgrade') output = verifiedPaidUpgradeOrder(scope, candidate)
      else output = await findPaidStarterBasis({ list: async () => ({ items: [candidate], pagination: { max_page: 1 } }) }, scope)
    }
    if (kind === 'refund') output = verifiedPolarPeriodRefund(input.config, input.workspaceId, input.orderId, candidate)
    cases.push({ kind, input, valid: true, output: json(output ?? null) })
  } catch (error) {
    cases.push({ kind, input, valid: false, error: error.name === 'ZodError' || error instanceof TypeError ? 'INVALID_BILLING_INPUT' : error.message })
  }
}
const max = Number.MAX_SAFE_INTEGER
const numbers = [undefined, null, false, '0', -max - 1, -max, -1000, -1, 0, 0.5, 1, 200, 1000, 1200, max, max + 1]
const amounts = ['net_amount', 'tax_amount', 'total_amount', 'due_amount', 'applied_balance_amount', 'refunded_amount', 'refunded_tax_amount']
await add('amounts', paid)
for (const field of amounts) for (const value of numbers) await add('amounts', { ...paid, [field]: value })
for (const net of [0, 1, 1000, max - 1, max]) for (const tax of [0, 1, 200]) for (const balance of [-max, -1200, -1, 0, 1, max]) {
  const total = net + tax
  await add('amounts', { ...paid, net_amount: net, tax_amount: tax, total_amount: total, applied_balance_amount: balance, due_amount: Math.max(total + balance, 0) })
}
await add('upgrade', paid)
for (const reason of ['subscription_create', 'subscription_cycle', 'subscription_update', 'purchase', null]) for (const status of ['paid', 'partially_refunded', 'refunded', 'pending', null]) for (const isPaid of [true, false, null]) await add('upgrade', { ...paid, billing_reason: reason, status, paid: isPaid })
for (const field of amounts) for (const value of numbers) await add('upgrade', { ...paid, [field]: value })
for (const patch of [{ customer: { external_id: 'forge:workspace:other' } }, { subscription_id: other }, { product_id: starter }, { currency: 'eur' }, { id: orderId.toUpperCase() }, { id: other }, { id: 'bad' }, { id: null }, { id: undefined }, { items: [] }, { items: null }, { items: 'bad' }]) await add('upgrade', { ...paid, ...patch })
for (const amount of [0, 1000]) for (const status of ['paid', 'partially_refunded']) for (const refund of [0, amount]) await add('upgrade', { ...paid, net_amount: amount, tax_amount: 0, total_amount: amount, due_amount: 0, applied_balance_amount: -amount, refunded_amount: refund, refunded_tax_amount: 0, status, items: [{ ...line, amount, tax_amount: 0 }] })
const dates = [undefined, null, false, 0, '', 'bad', '2027-01-15', '2027-01-15T12:00:00', '2027-01-15T12:00Z', '2027-01-15T12:00:00+00:00', '2027-01-15T14:00:00+02:00', '2027-01-15T12:00:00.123456Z', '2027-02-30T12:00:00Z', '2027-01-15T12:00:60Z', start, end, '2026-12-31T23:59:59.999Z', '2027-01-31T23:59:59.999Z']
for (const value of dates) {
  await add('upgrade', { ...paid, created_at: value })
  for (const field of ['start_timestamp', 'end_timestamp']) await add('upgrade', { ...paid, items: [{ ...line, [field]: value }] })
}
for (const reason of ['subscription_cycle', 'subscription_update']) for (const proration of [undefined, null, false, true, 0, 'true']) for (const lineStart of [start, created, end]) await add('upgrade', { ...paid, billing_reason: reason, items: [{ ...line, proration, start_timestamp: lineStart }] })
for (const amount of numbers) await add('upgrade', { ...paid, items: [{ ...line, amount }] })
for (const values of [[1500, -500], [500, 500], [1000, -1], [max, max, -max, -max, 1000], [max, 1, -max, 999], [max, 2, -max, 999], [max, max], [-max, -max, max, max, 1000]]) await add('upgrade', { ...paid, items: values.map(amount => ({ ...line, amount })) })
await add('upgrade', cycle, { context: { ...context, productId: starter } })
await add('starter-basis', cycle, { context: { ...context, productId: starter } })
for (const reason of ['subscription_create', 'subscription_cycle', 'subscription_update', 'purchase', null]) for (const status of ['paid', 'partially_refunded', 'refunded', 'pending']) for (const proration of [false, true]) await add('starter-basis', { ...cycle, billing_reason: reason, status, items: [{ ...cycle.items[0], proration }] }, { context: { ...context, productId: starter } })
for (const value of dates) await add('starter-basis', { ...cycle, items: [{ ...cycle.items[0], start_timestamp: value }] }, { context: { ...context, productId: starter } })
for (const patch of [{ customer: { external_id: 'other' } }, { subscription_id: other }, { product_id: plus }, { currency: 'eur' }, { items: [] }, { id: 'bad' }, { created_at: end }, { refunded_amount: 1000, refunded_tax_amount: 200 }, { items: [{ ...cycle.items[0], amount: 500 }, { ...cycle.items[0], amount: 500 }] }]) await add('starter-basis', { ...cycle, ...patch }, { context: { ...context, productId: starter } })
for (const value of [start, created, end, '2026-12-01T00:00:00.000Z']) await add('starter-basis', cycle, { context: { ...context, productId: starter, upgradeStart: value } })
for (const order of [periodRefund, upgradeRefund]) {
  await add('refund', order)
  for (const field of amounts) for (const value of numbers) await add('refund', { ...order, [field]: value })
  for (const status of [undefined, null, 'paid', 'partially_refunded', 'refunded', 'pending']) for (const refunded_amount of [0, 500, 1000]) for (const refunded_tax_amount of [0, 100, 200]) await add('refund', { ...order, status, refunded_amount, refunded_tax_amount })
  for (const reason of [undefined, null, 'subscription_create', 'subscription_cycle', 'subscription_update', 'purchase']) await add('refund', { ...order, billing_reason: reason })
  for (const value of dates) {
    await add('refund', { ...order, modified_at: value })
    for (const field of ['start_timestamp', 'end_timestamp']) await add('refund', { ...order, items: [{ ...order.items[0], [field]: value }] })
  }
  for (const field of ['amount', 'tax_amount']) for (const value of numbers) await add('refund', { ...order, items: [{ ...order.items[0], [field]: value }] })
  for (const proration of [undefined, null, 0, 'true', false, true]) await add('refund', { ...order, items: [{ ...order.items[0], proration }] })
  for (const patch of [{ id: other }, { id: orderId.toUpperCase() }, { customer: { external_id: 'forge:workspace:other' } }, { currency: 'eur' }, { currency: 'gbp' }, { product_id: other }, { subscription_id: 'bad' }, { subscription_id: null }, { subscription_id: undefined }, { items: [] }, { items: [order.items[0], order.items[0]] }]) await add('refund', { ...order, ...patch })
  for (const id of [orderId.toUpperCase(), 'bad', other]) await add('refund', { ...order, id }, { orderId: id })
  await add('refund', order, { config: { ...config, environment: 'production' } })
  await add('refund', order, { config: { ...config, paidProducts: { starter: { eur: order.product_id, usd: order.product_id }, plus: { eur: order.product_id, usd: order.product_id } } } })
}
for (const values of [[1500, -500], [500, 500], [1000, -1], [max, max, -max, -max, 1000], [max, 1, -max, 999], [max, 2, -max, 999], [max, max]]) await add('refund', { ...upgradeRefund, items: values.map((amount, index) => ({ ...line, amount, tax_amount: index === 0 ? 200 : 0 })) })
for (const taxes of [[300, -100], [100, 100], [200, -1], [max, max, -max, -max, 200], [max, 1, -max, 199]]) await add('refund', { ...upgradeRefund, items: taxes.map((tax_amount, index) => ({ ...line, amount: index === 0 ? 1000 : 0, tax_amount })) })
await add('refund', { ...upgradeRefund, items: [{ ...line, amount: 500, tax_amount: 100 }, { ...line, amount: 500, tax_amount: 100, start_timestamp: start }] })
await add('refund', { ...upgradeRefund, items: [{ ...line, start_timestamp: '2027-01-15T14:00:00+02:00' }, { ...line, amount: 0, tax_amount: 0, start_timestamp: created }] })
// Null records are aborts at their source evaluation stage, not ordinary
// ineligible invoices that may silently fall through to another paid candidate.
for (const kind of ['upgrade', 'starter-basis', 'refund']) {
  for (const order of [null, false, 0, 'bad', {}]) await add(kind, order)
}
for (const customer of [undefined, null, false, 0, 'bad', {}]) {
  await add('upgrade', { ...paid, customer })
  await add('starter-basis', { ...cycle, customer }, { context: { ...context, productId: starter } })
  await add('refund', { ...upgradeRefund, customer })
  await add('refund', { ...upgradeRefund, id: other, customer })
}
for (const items of [undefined, null, [], [null], [cycle.items[0], null], [{ ...cycle.items[0], amount: 'bad' }, null]]) {
  await add('starter-basis', { ...cycle, items }, { context: { ...context, productId: starter } })
}
for (const items of [[null], [line, null], [{ ...line, amount: 'bad' }, null], [null, { ...line, amount: 'bad' }]]) {
  await add('upgrade', { ...paid, items })
  await add('refund', { ...upgradeRefund, items })
}
for (const patch of [{ id: 'bad' }, { created_at: 'bad' }, { created_at: end }, { net_amount: null }]) await add('upgrade', { ...paid, ...patch, items: [null] })
await add('starter-basis', { ...cycle, customer: null, items: [] }, { context: { ...context, productId: starter } })
await add('refund', { ...upgradeRefund, items: [{ ...line, proration: false }, null] })
const path = new URL('../rust/crates/forge-core/data/billing-provider-orders-reference.json', import.meta.url)
const output = JSON.stringify({ cases }, null, 2) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== output) throw Error('Billing provider order source fixtures are stale')
} else writeFileSync(path, output)
console.log(`Billing provider order source fixtures: ${cases.length}`)
