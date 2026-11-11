// Run the application's actual invitation policy and mail composers. The provider
// is an in-memory stub; this exporter cannot send a message or contact a service.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { classifyInvitationDelivery, invitationEffectKey } from '../apps/forge/src/application/workflows/invitation-delivery-policy.ts'
import { canRetryInvitationWorkflowRun } from '../apps/forge/src/application/workflows/invitation-workflow-policy.ts'

let providerError = null, captured = null
mock.module('@tanstack/react-start/server-only', () => ({}))
mock.module('@/application/observability/telemetry.server', () => ({observeOperation: (_name, run) => run()}))
mock.module('resend', () => ({Resend: class {
  emails = {send: async (message, options) => {
    captured = {message, options}
    return {data: providerError ? null : {id: 'fixture-email-id'}, error: providerError}
  }}
}}))
process.env.FORGE_ENVIRONMENT = 'dev'
process.env.RESEND_API_KEY = 'fixture-not-a-credential'
process.env.RESEND_FROM_EMAIL = 'Forge <fixture@example.test>'
const {isInvitationWorkflowEnabled} = await import('../apps/forge/src/application/workflows/workflow-feature-flags.server.ts')
const {sendTransactionalEmail, EmailDeliveryError} = await import('../apps/forge/src/application/mail/mail.server.ts')
const {sendWorkspaceInvitationEmail} = await import('../apps/forge/src/application/mail/auth-emails.server.tsx')
const requireFromApp = createRequire(new URL('../apps/forge/package.json', import.meta.url))
const {render} = requireFromApp('@react-email/render')

const now = new Date('2030-01-01T00:00:00Z')
const decisions = []
for (const effect of ['initial','reminder-24h']) for (const status of ['pending','accepted','rejected','canceled','expired',''])
for (const remaining of [-1,0,1,899999,900000,900001,86400000]) {
  const expiresAt = new Date(+now + remaining)
  decisions.push({effect,status,expiresAt,now,decision:classifyInvitationDelivery({effect,status,expiresAt,now}),key:invitationEffectKey('fixture-invitation',effect)})
}
const starts = []
for (const sdkRunId of [null,'','external-sdk-id']) for (const state of ['queued','starting','running','completed','failed-to-start','failed','cancelled',''])
  starts.push({sdkRunId,state,allowed:canRetryInvitationWorkflowRun({sdkRunId,state})})
const flags = []
for (const flag of ['true','false','TRUE','1','']) for (const allowlist of ['',',','fixture',' fixture , other ','\uFEFFfixture\u00a0', 'Fixture']) for (const workspace of ['fixture','other','']) {
  process.env.FORGE_FEATURE_INVITATION_WORKFLOW = flag
  process.env.FORGE_INVITATION_WORKFLOW_WORKSPACE_ALLOWLIST = allowlist
  flags.push({flag,allowlist,workspace,enabled:isInvitationWorkflowEnabled(workspace)})
}
const failures = []
for (const statusCode of [null,400,401,403,408,409,422,425,429,500,503])
for (const name of ['validation_error','application_error','internal_server_error','concurrent_idempotent_requests']) {
  providerError = {statusCode,name,message:'private provider details'}
  try {
    await sendTransactionalEmail({to:'delivered@resend.dev',subject:'Fixture',text:'Fixture',react:null,category:'workspace-invitation'})
    throw Error('Expected provider failure')
  } catch (error) {
    if (!(error instanceof EmailDeliveryError)) throw error
    failures.push({statusCode,name,retryable:error.retryable,retrySeconds:error.retryable ? (error.statusCode === 429 ? 60 : 5) : null})
  }
}
providerError = null
const messages = []
for (const role of ['owner','admin','member']) for (const reminder of [false,true])
for (const inviterName of ['Ada <script>FORGE_INVITATION_URL_MARKER</script>','x'.repeat(149)+'😀','😀'.repeat(90),'Ada']) {
  const input = {id:'fixture/id & +',email:'delivered@resend.dev',role,organizationName:'Forge <&> "Team"',inviterName,inviterEmail:'ada@example.test',appUrl:'https://forge.example.test/base',reminder,idempotencyKey:invitationEffectKey('fixture/id & +',reminder?'reminder-24h':'initial')}
  await sendWorkspaceInvitationEmail(input)
  const {react,...payload} = captured.message
  const htmlHash = createHash('sha256').update(await render(react)+'\n').digest('hex')
  messages.push({input,payload,htmlHash,key:captured.options.idempotencyKey})
}
const output = JSON.stringify({decisions,starts,flags,failures,messages},null,2)+'\n'
const path = new URL('../rust/crates/forge-core/data/invitation-reference.json', import.meta.url)
if (process.argv.includes('--check')) {
  if (readFileSync(path,'utf8') !== output) throw Error('Invitation reference changed; review native policy and mail parity.')
} else writeFileSync(path,output)
console.log(`Invitation reference: ${decisions.length} delivery decisions, ${starts.length} start states, ${flags.length} gates, ${failures.length} errors, ${messages.length} messages`)
