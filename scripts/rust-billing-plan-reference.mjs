// Actual owning orchestration with deterministic dependency replies. Captured
// traces, including reads after failed effects, are replayed by the Rust adapter.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
process.env.TZ = 'UTC'
mock.module('@tanstack/react-start/server-only', () => ({}))
mock.module(new URL('../apps/forge/src/application/billing/subscription-reconciliation.server.ts', import.meta.url).pathname, () => ({applyVerifiedSubscriptionSnapshot() { throw Error('Fixture must inject persistence') }}))
const { PolarPlanChanger } = await import('../apps/forge/src/application/billing/polar-plan-change.server.ts')
const { PolarSeatRenewalScheduler } = await import('../apps/forge/src/application/billing/polar-seat-renewal.server.ts')
const json = value => JSON.parse(JSON.stringify(value))
const config = {
  enabled: true, environment: 'sandbox', accessToken: 'fixture-token', webhookSecret: 'fixture-secret', appUrl: 'https://forge.test',
  paidProducts: {starter:{eur:'11111111-1111-4111-8111-111111111111',usd:'22222222-2222-4222-8222-222222222222'},plus:{eur:'33333333-3333-4333-8333-333333333333',usd:'44444444-4444-4444-8444-444444444444'}},
}
const id = 'abcdefab-cdef-4abc-8def-abcdefabcdef', orderId = '55555555-5555-4555-8555-555555555555'
const start = '2027-01-01T00:00:00.000Z', end = '2027-02-01T00:00:00.000Z', now = '2027-01-15T12:00:00.000Z'
const actor = {userId:'user',workspaceId:'workspace',workspaceRole:'owner',authentication:{kind:'session',sessionId:'session'},scopes:null}
const context = {workspaceId:'workspace',subscriptionId:id,billableMembers:5,projectedPlan:'starter'}
function subscription(plan = 'starter') {
  return {id,product_id:config.paidProducts[plan].eur,currency:'eur',amount:plan === 'starter' ? 3000 : 4800,seats:3,
    customer:{external_id:'forge:workspace:workspace'},status:'active',recurring_interval:'month',recurring_interval_count:1,
    modified_at:start,current_period_start:start,current_period_end:end,past_due_at:null,cancel_at_period_end:false,
    pause_at_period_end:false,paused_at:null,resumes_at:null,ends_at:null,ended_at:null,pending_update:null}
}
const pending = (patch = {}) => ({id:'pending',created_at:now,modified_at:null,applies_at:end,product_id:null,seats:null,units:null,...patch})
const paid = {id:orderId,subscription_id:id,product_id:config.paidProducts.plus.eur,currency:'eur',customer:{external_id:'forge:workspace:workspace'},
  billing_reason:'subscription_update',status:'paid',paid:true,net_amount:1800,tax_amount:360,total_amount:2160,due_amount:2160,
  applied_balance_amount:0,refunded_amount:0,refunded_tax_amount:0,created_at:now,
  items:[{amount:1800,proration:true,start_timestamp:now,end_timestamp:end}]}
const errorCode = error => error.code ?? (['ZodError','TypeError'].includes(error.name) ? 'INVALID_BILLING_INPUT' : error.message)
const cases = []
async function add(name, kind, options = {}) {
  const selectedConfig = options.config ?? config
  let current = json(options.subscription ?? subscription(options.plan))
  const currentActor = json(options.actor ?? actor)
  const contexts = json(options.contexts ?? [{...context, projectedPlan:options.plan ?? 'starter', ...options.context}])
  const trace = [], outcomes = []
  let contextIndex = 0, getIndex = 0, updateIndex = 0
  const call = async (kind, input, fn) => {
    const entry = {kind,...json(input)}
    trace.push(entry)
    try { const result = await fn(); entry.output = json(result); return json(result) }
    catch (error) { entry.error = errorCode(error); throw error }
  }
  const resolve = candidate => call('context',{actor:candidate},() => {
    contextIndex++
    if (contextIndex === options.failContext) throw Error('BILLING_ACTOR_REVOKED')
    return contexts[Math.min(contextIndex-1, contexts.length-1)]
  })
  const client = {
    subscriptions:{
      get: subId => call('get',{id:subId},() => {
        getIndex++
        if (getIndex === options.failGet) throw Error('BILLING_PROVIDER_UNAVAILABLE')
        Object.assign(current, options.getPatches?.[getIndex] ?? {})
        return current
      }),
      update: (subId,body) => call('update',{id:subId,body},() => {
        updateIndex++
        if (updateIndex === options.failUpdateBefore) throw Error('BILLING_PROVIDER_UNAVAILABLE')
        if ('product_id' in body && body.product_id) {
          if (body.proration_behavior === 'next_period') current.pending_update = {...(current.pending_update ?? pending()),product_id:body.product_id}
          else {current.product_id=body.product_id;current.amount=4800;current.pending_update=null}
        } else if ('seats' in body) {
          if (body.seats === current.seats) {
            if (current.pending_update?.product_id) current.pending_update.seats=null
            else current.pending_update=null
          } else current.pending_update={...(current.pending_update ?? pending()),seats:body.seats}
        } else if ('pending_update' in body) current.pending_update=null
        current.modified_at=now
        Object.assign(current, options.updatePatches?.[updateIndex] ?? {})
        if (updateIndex === options.failUpdateAfter) throw Error('BILLING_PROVIDER_UNAVAILABLE')
        return current
      }),
    },
    orders:{
      get: () => { throw Error('Plan fixture does not retrieve an individual order') },
      list: query => call('orders',{query},() => {
        if (options.failOrders) throw Error('BILLING_PROVIDER_UNAVAILABLE')
        const pages = options.pages ?? [{items:options.paid === false ? [] : [paid],pagination:{max_page:1}}]
        return pages[Math.min(query.page-1,pages.length-1)]
      }),
    },
  }
  const apply = input => call('apply',{input},() => {
    if (options.failApply) throw Error('BILLING_PERSISTENCE_UNAVAILABLE')
    return Object.hasOwn(options, 'applyResult') ? options.applyResult : {outcome:'applied',replayed:false,effectivePlan:'business'}
  })
  const clock = () => {trace.push({kind:'clock',output:options.now ?? now});return new Date(options.now ?? now)}
  const service = kind === 'plan'
    ? new PolarPlanChanger(selectedConfig,resolve,client,apply,clock)
    : new PolarSeatRenewalScheduler(selectedConfig,resolve,client,clock)
  for (let attempt = 0; attempt < (options.attempts ?? 1); attempt++) {
    try { outcomes.push({valid:true,output:json(await (kind === 'plan' ? service.change(currentActor,options.target ?? 'plus') : service.schedule(currentActor)))}) }
    catch (error) {outcomes.push({valid:false,error:errorCode(error)})}
  }
  cases.push({name,kind,actor:currentActor,target:options.target ?? 'plus',...(selectedConfig===config?{}:{config:json(selectedConfig)}),outcomes,trace})
}
for (const plan of ['starter','plus']) for (const target of ['starter','plus']) for (const billableMembers of [1,3,5]) {
  for (const pendingSeats of [null,2,7]) {
    await add(`plan ${plan} to ${target}, members ${billableMembers}, pending ${pendingSeats}`,'plan',{
      plan,target,context:{billableMembers},subscription:{...subscription(plan),pending_update:pendingSeats===null?null:pending({seats:pendingSeats})},
    })
  }
}
for (const members of [1,3,5]) for (const seats of [null,1,3,7]) for (const downgrade of [false,true]) {
  await add(`seat ${members} from pending ${seats}, downgrade ${downgrade}`,'seats',{
    plan:downgrade?'plus':'starter',context:{billableMembers:members},
    subscription:{...subscription(downgrade?'plus':'starter'),pending_update:seats===null&&!downgrade?null:pending({seats,product_id:downgrade?config.paidProducts.starter.eur:null})},
  })
}
for (const kind of ['plan','seats']) {
  for (const role of ['admin',' member, admin ','member','guest','']) await add(`${kind} role ${role}`,kind,{actor:{...actor,workspaceRole:role}})
  await add(`${kind} api key`,kind,{actor:{...actor,authentication:{kind:'apiKey',credentialId:'key'}}})
  for (const field of ['workspaceId','subscriptionId','billableMembers','projectedPlan']) {
    for (const value of [undefined,null,0,'bad']) await add(`${kind} context ${field}:${String(value)}`,kind,{context:{[field]:value}})
  }
  for (const patch of [
    {customer:null},{customer:{}},{customer:{external_id:'forge:workspace:other'}},{id:orderId},{currency:'usd'},
    {status:'trialing'},{status:'past_due',past_due_at:start},{status:'unpaid'},{cancel_at_period_end:true},
    {pause_at_period_end:true},{paused_at:start},{ends_at:end},{ended_at:start},{seats:null},
    {current_period_end:now},{current_period_start:end},{current_period_end:'bad'},
    {recurring_interval_count:2},{product_id:orderId},
  ]) await add(`${kind} unsupported ${JSON.stringify(patch)}`,kind,{subscription:{...subscription(),...patch}})
  for (const field of ['cancel_at_period_end','pause_at_period_end','paused_at','ends_at','ended_at','pending_update','amount']) {
    for (const value of [undefined,null,false,0,'']) await add(`${kind} nullable ${field}:${String(value)}`,kind,{subscription:{...subscription(),[field]:value}})
  }
  for (const field of ['product_id','units','seats','applies_at']) {
    for (const value of [undefined,null,0,'bad']) await add(`${kind} pending ${field}:${String(value)}`,kind,{subscription:{...subscription(),pending_update:pending({seats:7,[field]:value})}})
  }
  for (const value of [start,end,'2027-01-15T12:00:00.000Z']) await add(`${kind} now ${value}`,kind,{now:value})
  await add(`${kind} provider read failed`,kind,{failGet:1})
  await add(`${kind} provider rejects update`,kind,{failUpdateBefore:1})
  await add(`${kind} lost accepted update then retry`,kind,{failUpdateAfter:1,attempts:2})
  await add(`${kind} confirmed retry`,kind,{attempts:2})
  for (const patch of [{seats:5},{amount:9999},{currency:'usd'},{product_id:config.paidProducts.starter.eur},{current_period_end:'2027-03-01T00:00:00.000Z'},{pending_update:pending({seats:8})},{pending_update:pending({seats:5,units:1})}]) {
    await add(`${kind} changed provider result ${JSON.stringify(patch)}`,kind,{updatePatches:{1:patch}})
  }
}
for (const target of ['starter','plus']) {
  await add(`clear downgrade target ${target}`,'plan',{plan:'plus',target,subscription:{...subscription('plus'),pending_update:pending({product_id:config.paidProducts.starter.eur,seats:7})}})
  await add(`refund prevents repurchase ${target}`,'plan',{plan:'plus',target,context:{projectedPlan:'starter',refundedUpgrade:true},subscription:{...subscription('plus'),pending_update:pending({product_id:config.paidProducts.starter.eur})}})
}
await add('failed upgrade dunning cannot reinvoice','plan',{subscription:{...subscription('plus'),status:'past_due',past_due_at:now,modified_at:now},paid:false})
await add('upgrade missing paid proof','plan',{paid:false})
await add('upgrade paid proof second page','plan',{pages:[{items:[],pagination:{max_page:2}},{items:[paid],pagination:{max_page:2}}]})
await add('upgrade payment lookup unavailable','plan',{failOrders:true})
await add('projection refuses grant','plan',{applyResult:{outcome:'applied',replayed:false,effectivePlan:'basic'}})
await add('projection stale','plan',{applyResult:{outcome:'stale',replayed:false,effectivePlan:'business'}})
await add('projection failed','plan',{failApply:true})
await add('projection null aborts confirmation','plan',{applyResult:null})
for (const failContext of [1,2,3,4,5]) await add(`authority revoked at refresh ${failContext}`,'plan',{failContext})
for (const patch of [{workspaceId:'other'},{subscriptionId:orderId},{billableMembers:4},{projectedPlan:'bad'},{refundedUpgrade:true}]) {
  await add(`context changes before charge ${JSON.stringify(patch)}`,'plan',{contexts:[context,{...context,...patch}]})
  await add(`context changes before seats ${JSON.stringify(patch)}`,'plan',{contexts:[context,context,context,context,{...context,...patch}]})
}
for (const patch of [{status:'unpaid',modified_at:now},{pause_at_period_end:true},{status:'paused',paused_at:now,modified_at:now}]) {
  await add(`restrictive state on post-charge read ${JSON.stringify(patch)}`,'plan',{getPatches:{2:patch}})
}
await add('early downgrade cannot be confirmed','plan',{plan:'plus',target:'starter',updatePatches:{1:{product_id:config.paidProducts.starter.eur}}})
await add('member count changed at last seat write','plan',{contexts:[context,context,context,context,{...context,billableMembers:6}]})
// Seat coercion intentionally differs from the strict subscription observation schema.
for (const value of [null,0,false,'2027-01-01','2027-01-01T00:00:00','2027-01-01T00:00:00+0000','2027-01-01T01:00:00+01:00']) {
  await add(`seat period date ${JSON.stringify(value)}`,'seats',{subscription:{...subscription(),current_period_start:value}})
}
for (const value of [end,'2027-02-01','2027-02-01T00:00:00','2027-02-01T00:00:00+0000','2027-02-01T01:00:00+01:00']) {
  for (const kind of ['plan','seats']) await add(`${kind} pending date ${value}`,kind,{subscription:{...subscription(),pending_update:pending({seats:7,applies_at:value})}})
}
const path = new URL('../rust/crates/forge-core/data/billing-plan-reference.json', import.meta.url)
const output = JSON.stringify({config,cases},null,2)+'\n'
if (process.argv.includes('--check')) {
  if (readFileSync(path,'utf8') !== output) throw Error('Billing plan source fixtures are stale')
} else writeFileSync(path,output)
console.log(`Billing plan and seat source fixtures: ${cases.length}`)
