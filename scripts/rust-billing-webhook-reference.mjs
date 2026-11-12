// Execute both the pinned SDK signature validator and the owning HTTP handler.
// Event callbacks record identities only; there is no provider or database I/O.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
mock.module('@tanstack/react-start/server-only', () => ({}))
for (const [file, name] of [
  ['subscription-reconciliation.server.ts', 'applyVerifiedSubscriptionSnapshot'],
  ['subscription-refund.server.ts', 'applyVerifiedPeriodRefund'],
]) mock.module(new URL(`../apps/forge/src/application/billing/${file}`, import.meta.url).pathname, () => ({ [name]: () => { throw Error('Unexpected persistent effect') } }))
const { handlePolarWebhook } = await import('../apps/forge/src/application/billing/polar-webhook.server.ts')
const sdk = readFileSync(new URL('../apps/forge/node_modules/@polar-sh/sdk/dist/2026-10/index.mjs', import.meta.url), 'utf8')
const known = JSON.parse(sdk.match(/const knownEventTypes =[\s\S]*?new Set\((\[[\s\S]*?\])\)/)[1])
const now = '2027-01-15T12:00:00.250Z', nativeNow = Date.now
Date.now = () => +new Date(now)
const timestamp = Math.floor(Date.now() / 1000)
const config = { enabled: true, environment: 'sandbox', accessToken: 'fixture-token', webhookSecret: 'fixture-webhook-secret', appUrl: 'https://forge.example.test', paidProducts: { starter: { usd: '00000000-0000-4000-8000-000000000001', eur: '00000000-0000-4000-8000-000000000002' }, plus: { usd: '00000000-0000-4000-8000-000000000003', eur: '00000000-0000-4000-8000-000000000004' } } }
const id = 'abcdefab-cdef-4def-8def-abcdefabcdef'
const event = { type: 'subscription.active', data: { id, customer: { external_id: 'forge:workspace:workspace' } } }
const copy = value => JSON.parse(JSON.stringify(value))
const bodyBytes = body => body === null ? null : body.base64 !== undefined ? Buffer.from(body.base64, 'base64') : Buffer.concat([Buffer.from(body.prefix ?? ''), Buffer.alloc(body.count ?? 0, body.byte ?? 32), Buffer.from(body.suffix ?? '')])
const bodyFor = value => ({ base64: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64') })
const signed = (raw, secret, eventId, stamp, options) => {
  const text = new TextDecoder().decode(raw)
  const key = options.signKeyBase64 ? Buffer.from(options.signKeyBase64, 'base64') : Buffer.from(secret)
  const second = options.signSecond ?? String(Math.floor(Number(stamp)))
  const content = options.signContent ?? `${eventId}.${second}.${text}`
  return createHmac('sha256', key).update(content).digest('base64')
}
const cases = []
async function add(name, options = {}) {
  const body = options.body === undefined ? bodyFor(Object.hasOwn(options, 'event') ? options.event : event) : options.body
  const raw = bodyBytes(body)
  const secret = options.secret ?? config.webhookSecret
  const eventId = options.eventId ?? 'event-fixture'
  const stamp = options.timestamp ?? String(timestamp)
  const sig = signed(raw ?? Buffer.alloc(0), secret, eventId, stamp, options)
  let signature = options.signature ? options.signature(sig) : `v1,${sig}`
  const headers = [['webhook-id', eventId], ['webhook-timestamp', stamp], ['webhook-signature', signature]]
  if (options.omitHeader) headers.splice(headers.findIndex(([key]) => key === options.omitHeader), 1)
  if (options.extraHeaders) headers.push(...options.extraHeaders)
  const method = options.method ?? 'POST'
  const actualBody = options.tamperedBody === undefined ? body : options.tamperedBody
  const request = new Request('https://forge.example.test/api/billing/polar/webhook', { method, headers, ...(actualBody !== null && !['GET', 'HEAD'].includes(method) ? { body: bodyBytes(actualBody) } : {}) })
  const trace = []
  const perform = async (kind, identity) => {
    trace.push({ kind, identity: copy(identity) })
    if (options.callbackFailure) throw Error('private provider token and SQL diagnostics')
    return { outcome: 'applied', replayed: false }
  }
  const reconciler = { reconcile: value => perform('subscription', value), ...(!options.noOrder ? { reconcileOrder: value => perform('order', value) } : {}) }
  const response = await handlePolarWebhook(request, { ...config, enabled: options.enabled ?? true, webhookSecret: secret }, reconciler, { reconcile: value => perform('refund', value) })
  // Store normalized header bytes, except explicit duplicates whose equivalent
  // Fetch comma-space joining is exercised independently by the native adapter.
  const normalizedHeaders = [...request.headers.entries()]
  const result = { status: response.status, cacheControl: response.headers.get('cache-control'), body: await response.json() }
  cases.push({ name, now, enabled: options.enabled ?? true, secret, method, body: ['GET','HEAD'].includes(method) ? null : actualBody, headers: options.extraHeaders ? headers : normalizedHeaders, noOrder: options.noOrder ?? false, callbackFailure: options.callbackFailure ?? false, trace, result })
}
try {
  for (const type of known) await add(`known-event/${type}`, { event: { ...event, type } })
  for (const type of ['subscription.unknown', 'ORDER.PAID', '', null, 10, {}, []]) await add(`unknown-event/${JSON.stringify(type)}`, { event: { ...event, type } })
  for (const value of [{}, [], null, true, 1, 'event', { data: event.data }]) await add(`not-event/${JSON.stringify(value)}`, { event: value })
  for (const data of [null, {}, { id }, { id, customer: {} }, { id: 'bad', customer: event.data.customer }, { id: id.toUpperCase(), customer: event.data.customer }, { id: null, customer: event.data.customer }, { id, customer: { external_id: 1 } }]) await add(`event-data/${JSON.stringify(data)}`, { event: { ...event, data } })
  for (const external_id of ['', 'forge:workspace:', 'forge:workspace: ', 'forge:workspace:\uFEFF', 'customer', 'FORGE:workspace:w', 'forge:workspace: workspace ', 'forge:workspace:語🙂', 'forge:workspace:' + 'x'.repeat(239), 'forge:workspace:' + 'x'.repeat(240), 'forge:workspace:' + '🙂'.repeat(120)]) await add(`customer/${JSON.stringify(external_id)}`, { event: { ...event, data: { id, customer: { external_id } } } })
  // Installed Zod bounds Unicode code points, including combining marks.
  for (const [name, suffix] of [
    ['emoji-255', '🙂'.repeat(239)], ['emoji-256', '🙂'.repeat(240)],
    ['combining-255', 'e\u0301'.repeat(119) + 'e'], ['combining-256', 'e\u0301'.repeat(120)],
  ]) await add(`customer-unicode/${name}`, { event: { ...event, data: { id, customer: { external_id: 'forge:workspace:' + suffix } } } })
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']) await add(`method/${method}`, { method })
  await add('disabled', { enabled: false })
  await add('disabled-before-method-and-signature', { enabled: false, method: 'GET', secret: '' })
  await add('missing-body', { body: null })
  await add('empty-body', { body: bodyFor('') })
  for (const body of ['{} broken', '\n', '{"type":', '<html/>']) await add(`malformed-json/${body}`, { body: bodyFor(body) })
  for (const omitHeader of ['webhook-id', 'webhook-timestamp', 'webhook-signature']) await add(`missing-header/${omitHeader}`, { omitHeader })
  await add('empty-secret', { secret: '' })
  await add('empty-event-id', { eventId: '' })
  await add('empty-signature', { signature: () => '' })
  await add('altered-bytes', { tamperedBody: bodyFor(JSON.stringify(event) + ' ') })
  await add('signed-body-is-not-event-state', { event: { ...event, data: { ...event.data, status: 'unpaid', product_id: 'untrusted', amount: 1, paid: true } } })
  for (const type of ['subscription.active', 'subscription.resumed', 'order.paid', 'order.refunded']) await add(`callback-failure/${type}`, { event: { ...event, type }, callbackFailure: true })
  await add('order-paid-without-handler', { event: { ...event, type: 'order.paid' }, noOrder: true })
  const current = Date.now() / 1000
  for (const value of [String(timestamp), String(timestamp + 0.9), String(current - 300), String(current - 300.001), String(current + 300), String(current + 300.001), String(timestamp - 300), String(timestamp + 300), '0x' + timestamp.toString(16), '0b' + timestamp.toString(2), '0o' + timestamp.toString(8), timestamp.toExponential(), '+' + timestamp, ' ' + timestamp + '\t', timestamp + '.', timestamp + 'e0', '', ' ', 'Infinity', '-Infinity', 'NaN', '1_000', '0x', '0xjunk', String(timestamp) + 'x']) await add(`timestamp/${JSON.stringify(value)}`, { timestamp: value })
  await add('fractional-timestamp-signed-with-fraction-rejected', { timestamp: String(timestamp + 0.9), signSecond: String(timestamp + 0.9) })
  await add('duplicate-timestamp', { extraHeaders: [['webhook-timestamp', String(timestamp)]] })
  await add('duplicate-id', { extraHeaders: [['webhook-id', 'other']] })
  await add('duplicate-signature', { extraHeaders: [['webhook-signature', 'v2,AAAA']] })
  const key = Buffer.from('sdk fixture key')
  for (const secret of [key.toString('base64'), key.toString('base64').replace(/=/g, ''), 'whsec_' + key.toString('base64'), 'whsec_' + key.toString('base64').replace(/=/g, '')]) for (const mode of ['raw', 'decoded']) await add(`secret/${secret}/${mode}`, { secret, ...(mode === 'decoded' ? { signKeyBase64: key.toString('base64') } : {}) })
  await add('secret-atob-whitespace', { secret: 'whsec_' + key.toString('base64').slice(0, 4) + '\t\n ' + key.toString('base64').slice(4), signKeyBase64: key.toString('base64') })
  await add('secret-atob-noncanonical-bits', { secret: 'whsec_AB==', signKeyBase64: 'AA==' })
  await add('secret-base64url-is-raw', { secret: 'whsec_____' })
  await add('secret-base64url-not-decoded', { secret: 'whsec_____', signKeyBase64: '////' })
  await add('secret-empty-base64-remainder-raw', { secret: 'whsec_' })
  for (const [name, transform] of [
    ['bad', () => 'v1,AAAA'], ['wrong-version', sig => `v2,${sig}`], ['no-version', sig => sig],
    ['unpadded', sig => `v1,${sig.replace(/=/g, '')}`],
    ['atob-tabs', sig => `v1,${sig.slice(0,8)}\t${sig.slice(8)}`],
    ['base64-space-separates-candidates', sig => `v1,${sig.slice(0,8)} ${sig.slice(8)}`],
    ['one-of-many', sig => `v2,AAAA v1,AAAA  v1,${sig}`],
    ['extra-comma-ignored', sig => `v1,${sig},ignored`],
    ['excess-padding', sig => `v1,${sig}=`],
    ['noncanonical-bits', sig => { const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; return `v1,${sig.slice(0,-2)}${alphabet[alphabet.indexOf(sig.at(-2)) + 1]}=` }],
  ]) await add(`signature/${name}`, { signature: transform })
  await add('utf8-bom-is-stripped-for-signature-only', { body: bodyFor('\uFEFF' + JSON.stringify(event)) })
  await add('utf8-replacement-before-signature', { body: { base64: Buffer.concat([Buffer.from('{"type":"subscription.active","data":{"id":"' + id + '","customer":{"external_id":"forge:workspace:'), Buffer.from([0xff]), Buffer.from('"}}}')]).toString('base64') } })
  const prefix = JSON.stringify(event).slice(0, -1) + ',"padding":"', suffix = '"}'
  for (const size of [1_048_575, 1_048_576, 1_048_577]) await add(`raw-body-size/${size}`, { body: { prefix, byte: 120, count: size - Buffer.byteLength(prefix) - Buffer.byteLength(suffix), suffix } })
  await add('oversize-before-invalid-signature', { body: { byte: 120, count: 1_048_577 }, signature: () => 'v1,AAAA' })
} finally { Date.now = nativeNow }
function save(relative, value) {
  const path = new URL(relative, import.meta.url), output = JSON.stringify(value, null, 2) + '\n'
  if (process.argv.includes('--check')) { if (readFileSync(path, 'utf8') !== output) throw Error(`Billing webhook reference changed: ${relative}`) }
  else writeFileSync(path, output)
}
save('../rust/crates/forge-core/data/billing-polar-webhook-events.json', known)
save('../rust/crates/forge-core/data/billing-webhook-reference.json', { config, cases })
console.log(`Billing webhook reference: ${cases.length} owning-handler and pinned-SDK cases`)
