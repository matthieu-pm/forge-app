// Pure question contracts and answers from Forge's installed EVE implementation.
// No provider, persistence, or required-approval authority is involved.
import { readFileSync, writeFileSync } from 'node:fs'
import { z } from '../services/agent-runtime/node_modules/eve/dist/src/compiled/zod/index.js'
import { ASK_QUESTION_INPUT_SCHEMA, ASK_QUESTION_OUTPUT_SCHEMA, ASK_QUESTION_TOOL_DEFINITION } from '../services/agent-runtime/node_modules/eve/dist/src/runtime/framework-tools/ask-question.js'
import { inputResponseSchema } from '../services/agent-runtime/node_modules/eve/dist/src/runtime/input/types.js'
import { extractQuestionInputRequests } from '../services/agent-runtime/node_modules/eve/dist/src/harness/input-extraction.js'
import { resolveTextToResponses } from '../services/agent-runtime/node_modules/eve/dist/src/channel/resolve-text.js'
import { resolvePendingInput, setPendingInputBatch } from '../services/agent-runtime/node_modules/eve/dist/src/harness/input-requests.js'

const copy = value => JSON.parse(JSON.stringify(value))
const parseCases = (schema, values) => values.map((input, index) => {
  const result = schema.safeParse(input)
  return { name: String(index), input, valid: result.success, ...(result.success ? { output: result.data } : {}) }
})
const option = { id: 'blue', label: 'Blue' }
const basic = { prompt: 'Which color?' }
const argumentsToParse = [null, [], true, 1, 'question', {}, basic, { prompt: '' }, { prompt: ' \n\uFEFF ' },
  { prompt: null }, { prompt: false }, { prompt: 2 }, { prompt: [] }, { prompt: {} },
  { ...basic, allowFreeform: true }, { ...basic, allowFreeform: false },
  ...[null, 0, 'true', [], {}].map(allowFreeform => ({ ...basic, allowFreeform })),
  { ...basic, options: [] }, { ...basic, options: [], allowFreeform: false },
  { ...basic, options: [option] }, { ...basic, options: [option], allowFreeform: true },
  { ...basic, options: [option], allowFreeform: false },
  { ...basic, options: [option, option] },
  { ...basic, options: [{ id: '', label: '' }] },
  ...[null, 'options', 1, {}].map(options => ({ ...basic, options })),
  ...[null, 'option', 1, [], {}, { id: 'x' }, { label: 'X' }, { ...option, id: null }, { ...option, label: 1 },
    { ...option, extra: true }, { ...option, description: null }, { ...option, style: null }, { ...option, style: 'muted' },
    { ...option, description: '' }, { ...option, style: 'primary' }, { ...option, style: 'danger' },
    { ...option, style: 'default', description: 'Details' }, { id: '語🙂', label: 'ÉCOLE', description: 'Pick a language' },
  ].map(value => ({ ...basic, options: [value] })),
  ...['extra', 'action', 'display', 'kind', 'requestId'].map(key => ({ ...basic, [key]: 'unexpected' })),
]
const inputs = parseCases(ASK_QUESTION_INPUT_SCHEMA, argumentsToParse)
const responses = parseCases(inputResponseSchema, [null, [], true, 1, 'answer', {},
  { requestId: 'q' }, { requestId: '' }, { requestId: 'call:not-a-uuid' },
  { requestId: 'q', optionId: 'blue' }, { requestId: 'q', text: 'Something else' },
  { requestId: 'q', optionId: '', text: '' }, { requestId: 'q', optionId: 'blue', text: 'Reason' },
  { requestId: 'q', optionId: 'approve' }, { requestId: 'q', text: ' \n\uFEFF🙂 ' },
  { requestId: null }, { requestId: 1 }, { requestId: 'q', optionId: null },
  { requestId: 'q', optionId: false }, { requestId: 'q', text: null }, { requestId: 'q', text: {} },
  { requestId: 'q', extra: true }, { requestId: 'q', status: 'answered' },
])
const outputs = parseCases(ASK_QUESTION_OUTPUT_SCHEMA, [null, [], false, 'answer', {},
  { status: 'answered' }, { status: 'ignored' }, { status: 'answered', optionId: 'blue' },
  { status: 'answered', text: 'Typed answer' }, { status: 'answered', optionId: 'blue', text: 'Both' },
  { status: 'ignored', optionId: 'blue', text: 'Allowed by the source schema' },
  { status: 'answered', optionId: '', text: '' }, { status: null }, { status: 'pending' },
  { status: 'answered', optionId: null }, { status: 'answered', text: false },
  { status: 'answered', requestId: 'q' }, { status: 'ignored', extra: true },
])
function request(callId, input) {
  return extractQuestionInputRequests({ excludedCallIds: new Set(), toolCalls: [{ toolCallId: callId, toolName: 'ask_question', input }] })[0]
}
const questions = inputs.filter(value => value.valid).flatMap(value => ['call-q', '', 'call:語🙂'].map(callId => ({
  name: `${value.name}/${callId}`, callId, input: value.output, output: request(callId, value.output),
})))

const text = []
function textCases(name, argumentsList, messages) {
  const requests = argumentsList.map((input, index) => request(`${name}:${index}`, input))
  for (const message of messages) text.push({ name: `${name}/${JSON.stringify(message)}`, text: message, requests, output: resolveTextToResponses(message, requests) })
}
const choices = [{ id: 'blue', label: 'Blue' }, { id: 'red', label: 'Red' }, { id: 'green', label: 'Green' }]
textCases('freeform', [basic, { ...basic, allowFreeform: false }, { ...basic, allowFreeform: true }, { ...basic, options: [], allowFreeform: false }],
  ['', ' ', '\t\n\r', '\uFEFF\u2000\u2028\u2029', '  Keep My CASE  ', '\uFEFF語🙂\u3000', '\u0085', '\u0085answer\u0085', '\u180eanswer\u180e', 'line one\nline two', '0', 'false'])
textCases('options', [{ ...basic, options: choices }, { ...basic, options: choices, allowFreeform: false }, { ...basic, options: choices, allowFreeform: true }],
  ['', ' ', 'blue', 'BLUE', '  Red  ', 'Green', 'something else', '0', '-0', '-1', '+1', '01', '1', '2', '3', '4',
    '1.0', '1.', '.1e1', '1e0', '2E0', '2e+0', '30e-1', '0x1', '0X2', '0o3', '0O2', '0b10', '0B11', '-0x1', '+0x1',
    '0x', '0b2', '0o8', '0x1g', '1_0', '1junk', '1 0', 'Infinity', '+Infinity', '-Infinity', 'NaN', '1e309', '1e-400',
    '1.0000000000000001', '1.9999999999999999', '2.0000000000000001', '3.0000000000000001', '9007199254740993',
    '\uFEFF2\u2029', '\u00852\u0085', '１', '٢', 'true', 'false'])
textCases('precedence', [{ ...basic, options: [{ id: 'alpha', label: 'Beta' }, { id: 'beta', label: 'Alpha' }, { id: '1', label: 'One' }] },
  { ...basic, options: [{ id: 'Same', label: 'Duplicate' }, { id: 'same', label: 'Duplicate' }] },
  { ...basic, options: [{ id: ' spaced ', label: ' padded ' }, { id: '', label: '' }] },
], ['alpha', 'ALPHA', 'beta', 'Beta', '1', 'One', 'Same', 'same', 'Duplicate', '2', ' spaced ', ' padded ', ''])
const unicodeChoices = [{ id: 'İ', label: 'Dotted I' }, { id: 'Σ', label: 'Sigma' }, { id: 'ΟΣ', label: 'Final Sigma' },
  { id: 'ẞ', label: 'Sharp S' }, { id: 'K', label: 'Kelvin' }, { id: '𐐀', label: 'Deseret' },
  { id: 'É', label: 'Composed' }, { id: 'e\u0301', label: 'Decomposed' }, { id: '👩‍💻', label: 'Emoji' }]
textCases('unicode', [{ ...basic, options: unicodeChoices }, { ...basic, options: unicodeChoices, allowFreeform: true }],
  ['İ', 'i', 'I', 'i\u0307', 'Σ', 'σ', 'ς', 'ΟΣ', 'οσ', 'ος', 'ẞ', 'ß', 'ss', 'K', 'K', 'k', '𐐀', '𐐨', 'É', 'é', 'e\u0301', 'E\u0301', '👩‍💻', 'EMOJI'])
textCases('fanout', [{ ...basic, options: [{ id: 'yes', label: 'Yes' }] }, { ...basic, options: [{ id: 'go', label: 'Yes' }] },
  { ...basic, options: [{ id: 'one', label: 'One' }] }, { ...basic, allowFreeform: true }], ['yes', 'YES', '1', 'go', 'new follow-up'])

// Obtain typed question results from the actual pending-input resolver. Its
// required-batch/deferred behavior belongs to a later milestone, not this one.
const results = []
for (const response of [undefined, ...responses.filter(value => value.valid).map(value => value.output)]) {
  const question = request(response?.requestId ?? 'q', { ...basic, options: choices, allowFreeform: false })
  const session = setPendingInputBatch({ session: { history: [] }, requests: [question], responseMessages: [] })
  const resolved = resolvePendingInput({ session, stepInput: response === undefined ? { message: 'Unrelated follow-up' } : { inputResponses: [response] } })
  results.push({ name: String(results.length), ...(response === undefined ? {} : { response }), output: resolved.messages.at(-1).content[0].output.value })
}

function save(relative, value) {
  const path = new URL(relative, import.meta.url), text = JSON.stringify(value, null, 2) + '\n'
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== text) throw Error(`Input reference changed: ${relative}`)
  } else writeFileSync(path, text)
}
save('../rust/crates/forge-core/data/input-tools.json', [{
  name: ASK_QUESTION_TOOL_DEFINITION.name,
  description: ASK_QUESTION_TOOL_DEFINITION.description,
  inputSchema: z.toJSONSchema(ASK_QUESTION_INPUT_SCHEMA, { target: 'draft-7', io: 'input', unrepresentable: 'any' }),
}])
save('../rust/crates/forge-core/data/input-reference.json', copy({ inputs, responses, outputs, questions, text, results }))
console.log(`Input reference: ${inputs.length} inputs, ${responses.length} responses, ${outputs.length} outputs, ${questions.length} requests, ${text.length} text matches, ${results.length} typed results`)
