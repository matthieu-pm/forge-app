// Execute the installed EVE implementations; projection only removes unrelated
// SDK session fields. This fixture neither issues nor consumes Forge grants.
import { readFileSync, writeFileSync } from 'node:fs'
import { classifyInputRequest } from '../services/agent-runtime/node_modules/eve/dist/src/harness/input-request-class.js'
import { coalesceTurnInputs } from '../services/agent-runtime/node_modules/eve/dist/src/harness/messages.js'
import { clearPendingSessionLimitPrompt, consumeDeferredStepInput, hasStepInput, resolvePendingInput } from '../services/agent-runtime/node_modules/eve/dist/src/harness/input-requests.js'
import { extractQuestionInputRequests, extractToolApprovalInputRequests } from '../services/agent-runtime/node_modules/eve/dist/src/harness/input-extraction.js'
import { createSessionLimitContinuationRequest } from '../services/agent-runtime/node_modules/eve/dist/src/harness/session-limit-continuation.js'
import { convertStaleResponsesToUserMessage, dropStaleSessionLimitContinuationResponses } from '../services/agent-runtime/node_modules/eve/dist/src/harness/stale-input-responses.js'

const pendingKey = 'eve.runtime.pendingInputBatch', deferredKey = 'eve.runtime.deferredStepInput', approvedKey = 'eve.runtime.hitl.approvedTools'
const copy = value => JSON.parse(JSON.stringify(value))
function session(state, history = []) {
  return { history, state: { ...(state.batch === undefined ? {} : { [pendingKey]: state.batch }), ...(Object.hasOwn(state, 'deferredInput') ? { [deferredKey]: state.deferredInput } : {}), ...(state.approvedKeys === undefined ? {} : { [approvedKey]: state.approvedKeys }) } }
}
function state(session) {
  return { ...(session.state?.[pendingKey] === undefined ? {} : { batch: session.state[pendingKey] }), ...(session.state?.[deferredKey] === undefined ? {} : { deferredInput: session.state[deferredKey] }), approvedKeys: session.state?.[approvedKey] ?? [] }
}
function consumed(result) { return { state: state(result.session), ...(result.input === undefined ? {} : { input: result.input }) } }
function resolution(result, history, batch) {
  const added = result.outcome === 'resolved' ? result.messages.slice(history.length + (batch?.responseMessages.length ?? 0)) : []
  return { outcome: result.outcome, state: state(result.session), messages: result.messages, toolParts: added.flatMap(message => message.role === 'tool' ? message.content : []),
    ...Object.fromEntries(['consumedMessage', 'deferredMessage', 'deferredContext', 'limitContinuation', 'rejectedActions'].filter(key => result[key] !== undefined).map(key => [key, result[key]])) }
}
function question(id, options) {
  const input = { prompt: `Question ${id}`, ...options }
  return extractQuestionInputRequests({ excludedCallIds: new Set(), toolCalls: [{ toolCallId: id, toolName: 'ask_question', input }] })[0]
}
function approval(id, toolName = 'update_team') {
  return extractToolApprovalInputRequests({ content: [{ type: 'tool-approval-request', approvalId: id, toolCall: { toolCallId: `${id}:call`, toolName, input: { fixture: id } } }] })[0]
}
const q = question('question'), qChoice = question('choice', { allowFreeform: false, options: [{ id: 'blue', label: 'Blue' }, { id: 'approve', label: 'Approve' }] })
const a = approval('approval'), b = approval('approval-two', 'write_file')
const limit = createSessionLimitContinuationRequest({ sessionId: 'fixture', violation: { kind: 'input', limit: 10, usedTokens: 10 } })
const event = { turnId: 'origin-turn', stepIndex: 3, sequence: 9 }
const history = [{ role: 'user', content: 'Original request' }]
const responseMessages = [{ role: 'assistant', content: [{ type: 'text', text: 'Please respond.' }] }]
const batch = requests => ({ requests, responseMessages, event })
const answer = (request, fields = {}) => ({ requestId: request.requestId, ...fields })
const cases = []
function add(kind, name, input, execute) {
  try { cases.push(copy({ kind, name, ...input, valid: true, output: execute() })) }
  catch { cases.push(copy({ kind, name, ...input, valid: false })) }
}
function resolveCase(name, current, stepInput, keys, prior = history) {
  const input = { state: current, history: prior, ...(stepInput === undefined ? {} : { input: stepInput }), ...(keys === undefined ? {} : { keys }) }
  add('resolve', name, input, () => {
    const approvalKeyCalls = []
    const result = resolvePendingInput({ session: session(current, prior), stepInput, ...(keys === undefined ? {} : { resolveApprovalKey: request => { approvalKeyCalls.push(request); return keys[request.requestId] } }) })
    return { resolution: resolution(result, prior, current.batch), approvalKeyCalls }
  })
}

for (const request of [q, qChoice, a, b, limit, { ...q, kind: 'custom' }]) add('required', request.requestId + '/' + request.kind, { request }, () => classifyInputRequest(request) === 'required')
const stepInputs = [undefined, {}, { message: '' }, { message: ' ' }, { message: 'Blue' }, { message: 'yes' }, { message: 'approve' }, { message: '1' },
  { message: null }, { message: [{ type: 'text', text: 'approve' }] }, { context: [{ source: 'context' }] }, { outputSchema: { type: 'string' } },
  { inputResponses: [] }, { inputResponses: null }, { inputResponses: [answer(q, { text: 'answer' })] },
  { inputResponses: [answer(a, { optionId: 'approve' })] }, { inputResponses: [answer(a, { optionId: 'deny' })] },
  { inputResponses: [answer(a, { optionId: 'invalid' })] }, { inputResponses: [answer(a)] },
  { inputResponses: [{ requestId: 'stale', optionId: 'approve' }], message: 'approve' },
  { inputResponses: [answer(limit, { optionId: 'continue' })] }, { inputResponses: [answer(limit, { optionId: 'stop' })] },
  { inputResponses: [answer(a, { optionId: 'approve' }), answer(b, { optionId: 'deny' }), answer(limit, { optionId: 'continue' })], message: 'Follow up', context: [{ source: 'new' }], outputSchema: { type: 'number' } },
]
for (const [index, input] of stepInputs.entries()) add('has-step', String(index), input === undefined ? {} : { input }, () => hasStepInput(input))
for (const [name, requests] of [['none', undefined], ['empty', []], ['question', [q]], ['questions', [q, qChoice]], ['approval', [a]], ['approvals', [a, b]], ['limit', [limit]], ['mixed', [q, qChoice, a, b, limit]]]) {
  const current = { ...(requests === undefined ? {} : { batch: batch(requests) }), approvedKeys: [] }
  for (const [index, input] of stepInputs.entries()) resolveCase(`${name}/${index}`, current, input)
}
resolveCase('all-questions-answered-but-required-unanswered', { batch: batch([q, question('freeform-two'), a]), approvedKeys: [] }, { message: 'An answer to both questions' })
resolveCase('old-explicit-approval-without-pending-batch', { approvedKeys: ['earlier'] }, { inputResponses: [answer(a, { optionId: 'approve' })], message: 'new task' })
for (const optionIds of [['approve', 'deny'], ['deny', 'approve'], ['invalid', 'approve'], ['approve', 'invalid']]) {
  resolveCase(`approval-duplicates/${optionIds}`, { batch: batch([a]), approvedKeys: ['existing', 'existing'] }, { inputResponses: optionIds.map(optionId => answer(a, { optionId })) })
  resolveCase(`question-duplicates/${optionIds}`, { batch: batch([q]), approvedKeys: [] }, { inputResponses: optionIds.map(optionId => answer(q, { optionId })) })
}
for (const optionIds of [['continue', 'stop'], ['stop', 'continue'], ['invalid', 'continue'], ['continue', 'invalid'], ['approve', 'stop']]) resolveCase(`limit-duplicates/${optionIds}`, { batch: batch([limit]), approvedKeys: [] }, { inputResponses: optionIds.map(optionId => answer(limit, { optionId })) })
for (const value of [undefined, event, null]) resolveCase(`rejected-origin/${JSON.stringify(value)}`, { batch: { requests: [a, b], responseMessages, ...(value === undefined ? {} : { event: value }) }, approvedKeys: [] }, { inputResponses: [answer(a, { optionId: 'deny' }), answer(b, { text: 'no' })] })
resolveCase('approval-key-override-and-nullish-fallback', { batch: batch([q, a, b]), approvedKeys: ['existing', 'existing'] }, { inputResponses: [answer(q, { optionId: 'approve' }), answer(a, { optionId: 'approve' }), answer(b, { optionId: 'approve' })] }, { question: '', approval: 'bound-capability', 'approval-two': null })
resolveCase('all-questions-unknown-response-ignored', { batch: batch([q, qChoice]), approvedKeys: [] }, { inputResponses: [{ requestId: 'stale', text: 'old response' }] })
resolveCase('only-session-limit-first-request-counts', { batch: batch([limit, { ...limit, requestId: 'second-limit' }]), approvedKeys: [] }, { inputResponses: [answer(limit, { optionId: 'stop' }), { requestId: 'second-limit', optionId: 'continue' }] })
resolveCase('existing-deferred-partial-coalesces', { batch: batch([q, a]), deferredInput: { message: 'earlier', context: [{ old: true }], outputSchema: { type: 'string' } }, approvedKeys: [] }, { inputResponses: [answer(q, { text: 'answer' })], message: 'later', context: [{ next: true }], outputSchema: null })
resolveCase('existing-deferred-resolved-approval-coalesces', { batch: batch([a]), deferredInput: { message: 'earlier', inputResponses: [answer(q, { text: 'queued' })] }, approvedKeys: [] }, { inputResponses: [answer(a, { optionId: 'approve' })], message: 'later', context: [{ next: true }] })
resolveCase('empty-fields-compact-on-required-deferral', { batch: batch([a]), approvedKeys: [] }, { message: '', context: [], inputResponses: [], messageConsumed: false, outputSchema: null, unrelated: 'discarded' })
resolveCase('required-context-only-not-deferred', { batch: batch([a]), approvedKeys: [] }, { context: [{ only: true }] })
resolveCase('empty-message-with-consumed-flag', { batch: batch([qChoice]), approvedKeys: [] }, { message: '', messageConsumed: true })
resolveCase('question-context-does-not-create-deferred-input', { batch: batch([q]), approvedKeys: [] }, { inputResponses: [answer(q, { text: 'answer' })], message: 'followup', context: [{ only: true }] })

const mergeInputs = [{}, { message: ' first ' }, { message: 'second' }, { message: ' \uFEFF ' }, { message: [] },
  { message: [{ type: 'text', text: ' ' }, { type: 'text', text: 'kept' }] },
  { message: [{ type: 'file', filename: 'context.pdf', data: 'bytes' }] },
  { inputResponses: [answer(q, { text: 'one' })], context: [{ first: true }], outputSchema: { type: 'string' }, messageConsumed: true, unrelated: 'discarded' },
  { inputResponses: [answer(q, { text: 'two' })], context: [{ second: true }], outputSchema: null },
  { inputResponses: [], context: [], outputSchema: false }, { outputSchema: null },
]
for (const [a, first] of mergeInputs.entries()) for (const [b, second] of mergeInputs.entries()) add('coalesce', `${a}/${b}`, { first, second }, () => coalesceTurnInputs(first, second))
for (const [name, first, second] of [['null-step', null, {}], ['null-message', { message: null }, {}], ['invalid-message', { message: false }, {}], ['invalid-text-part', { message: [{ type: 'text', text: 1 }] }, {}], ['null-part', { message: [null] }, {}]]) add('coalesce', name, { first, second }, () => coalesceTurnInputs(first, second))
for (const [index, deferredInput] of [undefined, ...mergeInputs].entries()) for (const [other, input] of [undefined, ...mergeInputs.slice(0, 4)].entries()) {
  const current = { batch: batch([q, a]), ...(deferredInput === undefined ? {} : { deferredInput }), approvedKeys: ['retained'] }
  add('consume', `${index}/${other}`, { state: current, ...(input === undefined ? {} : { input }) }, () => consumed(consumeDeferredStepInput({ session: session(current), input })))
}
for (const [name, requests] of [['none', undefined], ['empty', []], ['question', [q]], ['approval', [a]], ['limit', [limit]], ['two-limits', [limit, { ...limit, requestId: 'other-limit' }]], ['mixed-question', [limit, q]], ['mixed-approval', [limit, a]]]) {
  const current = { ...(requests === undefined ? {} : { batch: batch(requests) }), deferredInput: { message: 'retained' }, approvedKeys: ['retained'] }
  add('clear', name, { state: current }, () => state(clearPendingSessionLimitPrompt(session(current))))
}

function flow(name, initial, inputs) {
  add('flow', name, { state: initial, history, inputs: inputs.map(input => input === undefined ? {} : { input }) }, () => {
    let current = session(initial, history), messages = history
    return inputs.map(input => {
      const merged = consumeDeferredStepInput({ session: current, input })
      const pending = merged.session.state?.[pendingKey]
      const result = resolvePendingInput({ session: merged.session, history: messages, stepInput: merged.input })
      const output = { consumed: consumed(merged), resolution: resolution(result, messages, pending) }
      current = result.session
      messages = result.messages
      return output
    })
  })
}
flow('partial-explicit-then-text-suppressed-then-final', { batch: batch([q, qChoice, a, b, limit]), approvedKeys: [] }, [
  { inputResponses: [answer(q, { text: 'partial answer' })], message: 'First follow-up', context: [{ first: true }] },
  { message: 'approve', context: [{ second: true }] },
  { inputResponses: [answer(a, { optionId: 'approve' }), answer(b, { optionId: 'deny' }), answer(limit, { optionId: 'continue' })] },
  { message: 'new task' },
])
flow('text-answers-questions-required-remains', { batch: batch([q, a]), approvedKeys: [] }, [
  { message: 'detail' }, { message: 'approve' }, { inputResponses: [answer(a, { optionId: 'approve' })] }, undefined,
])
flow('unmatched-message-is-coalesced-before-option-matching', { batch: batch([a]), approvedKeys: [] }, [
  { message: 'new task' }, { message: 'approve' }, { inputResponses: [answer(a, { optionId: 'approve' })] }, undefined,
])
flow('stale-explicit-response-blocks-new-text-match', { batch: batch([a]), approvedKeys: [] }, [
  { inputResponses: [{ requestId: 'old-approval', optionId: 'approve' }] }, { message: 'approve' },
  { inputResponses: [answer(a, { optionId: 'deny' })] }, { inputResponses: [{ requestId: 'old-approval', optionId: 'approve' }], message: 'next task' },
])
flow('session-limit-stop-has-no-tool-parts', { batch: batch([limit]), approvedKeys: [] }, [
  { message: 'new task' }, { inputResponses: [answer(limit, { optionId: 'stop' })] }, undefined,
])

const questionCall = { type: 'tool-call', toolCallId: 'earlier-question', toolName: 'ask_question', input: { prompt: 'Original color?', options: [{ id: 'blue', label: 'Blue', description: 'The blue option' }] } }
const approvalCall = { type: 'tool-call', toolCallId: 'earlier-write', toolName: 'update_team', input: { name: 'Blue' } }
const approvalPart = { type: 'tool-approval-request', approvalId: 'earlier-approval', toolCallId: approvalCall.toolCallId }
const earlier = [{ role: 'assistant', content: [questionCall, approvalCall, approvalPart] }]
function staleCase(name, history, pendingIds, input) {
  add('stale', name, { history, pendingIds, ...(input === undefined ? {} : { input }) }, () => {
    const stepInput = dropStaleSessionLimitContinuationResponses({ pendingRequestIds: new Set(pendingIds), stepInput: input })
    return convertStaleResponsesToUserMessage({ history, pendingRequestIds: new Set(pendingIds), stepInput })
  })
}
for (const [index, input] of [undefined, {}, { message: 'new task' }, { inputResponses: [] },
  { inputResponses: [{ requestId: 'earlier-question', optionId: 'blue' }] },
  { inputResponses: [{ requestId: 'earlier-question', optionId: 'missing', text: '' }] },
  { inputResponses: [{ requestId: 'earlier-question', text: 'My answer' }] },
  { inputResponses: [{ requestId: 'earlier-question' }] },
  { inputResponses: [{ requestId: 'earlier-approval', optionId: 'approve' }] },
  { inputResponses: [{ requestId: 'earlier-approval', optionId: 'deny', text: 'No thanks' }] },
  { inputResponses: [{ requestId: 'unknown', optionId: 'approve' }] },
  { inputResponses: [{ requestId: 'unknown' }] },
  { inputResponses: [{ requestId: 'earlier-question', optionId: 'blue' }, { requestId: 'earlier-approval', optionId: 'approve' }] },
  { inputResponses: [{ requestId: limit.requestId, optionId: 'continue' }] },
  { inputResponses: [{ requestId: ':limit:input:123', optionId: 'continue' }, { requestId: 'unknown', text: 'keep' }] },
  { inputResponses: [{ requestId: 'x:limit:output:00', optionId: 'stop' }, { requestId: 'x:limit:input:1\n', text: 'not a limit' }] },
].entries()) {
  staleCase(`unmatched/${index}`, earlier, [], input)
  staleCase(`current-question/${index}`, earlier, ['earlier-question', limit.requestId], input)
}
for (const [index, message] of [undefined, '', ' \uFEFF ', 'Original composer', [], [{ type: 'text', text: ' ' }], [{ type: 'text', text: 'With attachment' }, { type: 'file', data: 'bytes' }]].entries()) staleCase(`content/${index}`, earlier, [], { inputResponses: [{ requestId: 'earlier-question', optionId: 'blue' }], ...(message === undefined ? {} : { message }), messageConsumed: false, context: [{ keep: true }], outputSchema: { type: 'string' } })
staleCase('latest-history-wins', [...earlier, { role: 'assistant', content: [{ ...questionCall, input: { prompt: 'New color?', options: [{ id: 'blue', label: 'New blue' }] } }] }], [], { inputResponses: [{ requestId: 'earlier-question', optionId: 'blue' }] })
staleCase('same-message-first-question-wins', [{ role: 'assistant', content: [questionCall, { ...questionCall, input: { prompt: 'Ignored duplicate' } }] }], [], { inputResponses: [{ requestId: 'earlier-question', optionId: 'blue' }] })
staleCase('inline-approval-descriptor', [{ role: 'assistant', content: [{ ...approvalPart, toolCallId: 'unknown', toolCall: approvalCall }] }], [], { inputResponses: [{ requestId: 'earlier-approval', optionId: 'approve' }] })
staleCase('automatic-approval-is-unknown', [{ role: 'assistant', content: [approvalCall, { ...approvalPart, isAutomatic: true }] }], [], { inputResponses: [{ requestId: 'earlier-approval', optionId: 'approve' }] })
staleCase('non-assistant-history-is-unknown', [{ role: 'user', content: [questionCall] }, { role: 'assistant', content: 'plain text' }], [], { inputResponses: [{ requestId: 'earlier-question', optionId: 'blue' }] })
staleCase('string-tool-arguments', [{ role: 'assistant', content: [{ ...questionCall, input: JSON.stringify(questionCall.input) }] }], [], { inputResponses: [{ requestId: 'earlier-question', optionId: 'blue' }] })
staleCase('invalid-tool-arguments', [{ role: 'assistant', content: [{ ...questionCall, input: 'invalid json' }] }], [], { inputResponses: [{ requestId: 'earlier-question', optionId: 'blue' }] })
staleCase('duplicate-responses-remain-ordered', earlier, [], { inputResponses: [{ requestId: 'earlier-question', optionId: 'blue' }, { requestId: 'earlier-question', text: 'Actually red' }] })
for (const input of [null, '', [], { prompt: null }, { prompt: ['red', null, 'blue'] }, { prompt: { nested: true } }]) staleCase(`prompt/${JSON.stringify(input)}`, [{ role: 'assistant', content: [{ ...questionCall, input }] }], [], { inputResponses: [{ requestId: 'earlier-question', text: 'reply' }] })

const path = new URL('../rust/crates/forge-core/data/pending-input-reference.json', import.meta.url)
const output = JSON.stringify({ cases }, null, 2) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== output) throw Error('Pending input reference changed')
} else writeFileSync(path, output)
const counts = Object.fromEntries([...new Set(cases.map(value => value.kind))].map(kind => [kind, cases.filter(value => value.kind === kind).length]))
console.log(`Pending input reference: ${cases.length} installed-EVE cases ${JSON.stringify(counts)}`)
