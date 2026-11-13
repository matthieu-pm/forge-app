// Execute the installed implementations. Authority markers are inert fixture
// data, never tokens. No provider, workflow hook or network call is made.
import { readFileSync, writeFileSync } from 'node:fs'
import { coalesceDeliveries } from '../services/agent-runtime/node_modules/eve/dist/src/harness/messages.js'
import { coalesceDeliverPayloads } from '../services/agent-runtime/node_modules/eve/dist/src/execution/deliver-payloads.js'
import { nextTurnDelivery } from '../services/agent-runtime/node_modules/eve/dist/src/execution/parked-delivery-wait.js'
import { resolvePendingInput } from '../services/agent-runtime/node_modules/eve/dist/src/harness/input-requests.js'
import { extractToolApprovalInputRequests } from '../services/agent-runtime/node_modules/eve/dist/src/harness/input-extraction.js'

const copy = value => JSON.parse(JSON.stringify(value))
const cases = []
async function add(kind, name, input, execute) {
  try { cases.push(copy({ kind, name, ...input, valid: true, output: await execute() })) }
  catch { cases.push(copy({ kind, name, ...input, valid: false })) }
}
const authority = run => ({ fixtureAuthority: run })
const delivery = (id, extras = {}) => ({ kind: 'deliver', requestId: id, payloads: [{ message: id }], ...extras })
const deliveries = [
  ['empty', []],
  ['singleton', [delivery('first', { firstMetadata: 'retained' })]],
  ['same-run', [delivery('first', { auth: authority('A') }), delivery('second', { auth: authority('A') })]],
  ['cross-run', [delivery('first', { auth: authority('A'), firstMetadata: 'retained' }), delivery('second', { auth: authority('C'), firstMetadata: 'discarded' })]],
  ['last-absent-authority', [delivery('first', { auth: authority('A') }), delivery('second')]],
  ['last-null-authority', [delivery('first', { auth: authority('A') }), delivery('second', { auth: null })]],
  ['null-then-authority', [delivery('first', { auth: null }), delivery('second', { auth: authority('C') })]],
  ['first-caller', [delivery('first', { caller: { fixtureCaller: 'A' } }), delivery('second')]],
  ['last-caller', [delivery('first'), delivery('second', { caller: { fixtureCaller: 'C' } })]],
  ['two-callers', [delivery('first', { caller: { fixtureCaller: 'A' } }), delivery('second', { caller: { fixtureCaller: 'C' } })]],
  ['same-caller-twice', [delivery('first', { caller: { fixtureCaller: 'A' } }), delivery('second', { caller: { fixtureCaller: 'A' } })]],
  ['null-caller', [delivery('first', { caller: null }), delivery('second')]],
  ['null-caller-barrier', [delivery('first', { caller: null }), delivery('second', { caller: { fixtureCaller: 'C' } })]],
  ['null-caller-then-absent-then-defined', [delivery('first', { caller: null }), delivery('middle'), delivery('last', { caller: { fixtureCaller: 'C' } })]],
  ['callerless-prefix', [delivery('first'), delivery('middle', { caller: { fixtureCaller: 'B' } }), delivery('third'), delivery('fourth', { caller: { fixtureCaller: 'D' } }), delivery('last')]],
  ['payload-order', [delivery('first', { payloads: [{ inputResponses: [{ requestId: 'approval', optionId: 'approve' }] }, { message: 'context' }] }), delivery('last', { payloads: [{ inputResponses: [{ requestId: 'approval', optionId: 'deny' }] }] })]],
]
for (const [name, input] of deliveries) {
  await add('deliveries', name, { deliveries: input }, () => coalesceDeliveries(copy(input)))
  await add('prefix', name, { deliveries: input }, async () => {
    const bufferedDeliveries = copy(input)
    const result = await nextTurnDelivery({
      bufferedDeliveries, bufferedSessionControls: [], sessionState: { hasProxyInputRequests: false },
      driverWritable: new WritableStream(),
      commandInbox: { async next() { return { done: true } }, consumeNext() {} },
    })
    return { result, remaining: bufferedDeliveries }
  })
}
const inputs = [{}, { message: 'first' }, { message: ' second ' }, { message: ' \uFEFF ' },
  { message: [{ type: 'text', text: 'file context' }, { type: 'file', data: 'fixture-bytes' }] },
  { inputResponses: [{ requestId: 'approval', optionId: 'approve' }], context: ['first'], outputSchema: { type: 'string' }, messageConsumed: true, extra: 'first' },
  { inputResponses: [{ requestId: 'approval', optionId: 'deny' }], context: ['last'], outputSchema: null, messageConsumed: false, extra: null },
  { runtimeActionResults: [{ fixtureResult: 'first' }], extra: 'last' },
]
await add('payloads', 'empty', { payloads: [] }, () => coalesceDeliverPayloads([]))
await add('payloads', 'single-null', { payloads: [null] }, () => coalesceDeliverPayloads([null]))
for (const [i, input] of inputs.entries()) {
  await add('payloads', `single/${i}`, { payloads: [input] }, () => coalesceDeliverPayloads(copy([input])))
  for (const [j, other] of inputs.entries()) await add('payloads', `pair/${i}/${j}`, { payloads: [input, other] }, () => coalesceDeliverPayloads(copy([input, other])))
}
const request = extractToolApprovalInputRequests({ content: [{ type: 'tool-approval-request', approvalId: 'approval', toolCall: { toolCallId: 'write', toolName: 'update_team', input: { fixture: true } } }] })[0]
const batch = { requests: [request], responseMessages: [], event: { turnId: 'fixture-turn', sequence: 1, stepIndex: 0 } }
for (const decisions of [['approve', 'deny'], ['deny', 'approve'], ['approve', 'invalid'], ['invalid', 'approve']]) {
  const payloads = decisions.map(optionId => ({ inputResponses: [{ requestId: request.requestId, optionId }] }))
  await add('resolved-payloads', decisions.join('/'), { payloads, batch }, () => {
    const merged = coalesceDeliverPayloads(copy(payloads))
    const resolved = resolvePendingInput({ session: { history: [], state: { 'eve.runtime.pendingInputBatch': copy(batch) } }, stepInput: merged })
    return { merged, outcome: resolved.outcome, messages: resolved.messages }
  })
}
const path = new URL('../rust/crates/forge-core/data/input-delivery-reference.json', import.meta.url)
const output = JSON.stringify({ cases }, null, 2) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== output) throw Error('Input delivery reference changed')
} else writeFileSync(path, output)
console.log(`Input delivery reference: ${cases.length} installed-EVE cases`)
