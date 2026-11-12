// Run the owning transaction functions against a deterministic command recorder.
// This verifies policy/order/serialization, not PostgreSQL constraints or locking.
// Those are exercised separately by real disposable PostgreSQL acceptance tests.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { pgTable, text } from '../apps/forge/node_modules/drizzle-orm/pg-core/index.js'
import * as authorization from '../apps/forge/src/application/authorization.ts'
const NativeDate=Date, clock='2027-01-15T12:00:00.000Z'
globalThis.Date=class extends NativeDate { constructor(...args){super(...(args.length?args:[clock]))} static now(){return +new NativeDate(clock)} }
const tables={
 organizations:pgTable('organization',{id:text('id')}),
 workspaceEntitlements:pgTable('workspace_entitlements',{workspaceId:text('workspace_id')}),
 billingEventReceipts:pgTable('billing_event_receipts',{environment:text('environment'),eventId:text('event_id')}),
 workspaceSecurityAuditEvents:pgTable('workspace_security_audit_events',{id:text('id')}),
}
const names=new Map([[tables.workspaceEntitlements,'entitlement'],[tables.billingEventReceipts,'receipt'],[tables.workspaceSecurityAuditEvents,'audit']])
const defaults={plan:'free',status:'active',source:'internal',sourceReference:null,providerEnvironment:null,providerUpdatedAt:null,providerStateHash:null,trialRedemptionId:null,paidUpgradeOrderId:null,terminatedAt:null,unsupportedPauseAt:null,paidActivatedAt:null,paymentFailedAt:null,graceExpiresAt:null,currentPeriodStart:null,currentPeriodEnd:null,cancelAtPeriodEnd:false,cancellationPeriodEnd:null,refundedPeriods:[],featureOverrides:{},updatedAt:clock}
const dates=['providerUpdatedAt','updatedAt','terminatedAt','unsupportedPauseAt','paidActivatedAt','paymentFailedAt','graceExpiresAt','currentPeriodStart','currentPeriodEnd','cancellationPeriodEnd']
const dateFields=(v,keys)=>Object.fromEntries(Object.entries(v).map(([k,x])=>[k,keys.includes(k)&&typeof x==='string'?new Date(x):x]))
const json=v=>JSON.parse(JSON.stringify(v))
let state, context, commands
const record=(operation,values,set)=>{
 const command={operation,...(values?{values:json(values)}:{}),...(set?{set:json(set)}:{})};commands.push(command)
 if(operation==='entitlement_insert'||operation==='entitlement_upsert')state=state===null?dateFields({...defaults,...json(values)},dates):dateFields({...json(state),...json(set??values)},dates)
 if(operation==='entitlement_update')state=dateFields({...json(state),...json(set)},dates)
}
const tx={
 select:()=>({from:()=>({where:()=>({for:async()=>context.workspaceExists===false?[]:[{id:'workspace'}]})})}),
 query:{workspaceEntitlements:{findFirst:async()=>state},billingEventReceipts:{findFirst:async()=>context.receipt??null},members:{findFirst:async()=>context.memberRole==null?null:{role:context.memberRole}}},
 insert:table=>({values:values=>({then:resolve=>{record(names.get(table)+'_insert',values);resolve()},onConflictDoUpdate:async({set})=>record(names.get(table)+'_upsert',values,set)})}),
 update:table=>({set:set=>({where:async()=>record(names.get(table)+'_update',null,set)})}),
}
mock.module('@tanstack/react-start/server-only',()=>({}))
mock.module('@/application/authorization',()=>authorization)
mock.module('@/db',()=>({...tables,db:{transaction:async fn=>fn(tx)}}))
const {applyVerifiedSubscriptionSnapshot}=await import('../apps/forge/src/application/billing/subscription-reconciliation.server.ts')
const {applyVerifiedPeriodRefund}=await import('../apps/forge/src/application/billing/subscription-refund.server.ts')
const cases=[]
async function add(kind,input,ctx={}){
 context={now:clock,workspaceExists:true,previous:null,receipt:null,memberRole:'owner',...json(ctx)}
 state=context.previous===null?null:dateFields({...defaults,...context.previous},dates)
 context.previous=state===null?null:json(state);commands=[]
 let argument=json(input)
 if(kind==='snapshot'){
  argument.snapshot=dateFields(argument.snapshot,['updatedAt','currentPeriodStart','currentPeriodEnd','pastDueAt','terminatedAt','unsupportedPauseAt'])
  if(argument.snapshot.paidUpgrade)argument.snapshot.paidUpgrade=dateFields(argument.snapshot.paidUpgrade,['periodStart','periodEnd','createdAt'])
  if(argument.planChange)argument.planChange=dateFields(argument.planChange,['effectiveAt'])
 }
 const item={kind,input:json(input),context}
 try{const answer=await(kind==='snapshot'?applyVerifiedSubscriptionSnapshot(argument):applyVerifiedPeriodRefund(argument));cases.push({...item,valid:true,output:{commands,answer}});return json(state)}
 catch(error){cases.push({...item,valid:false,error:error.code??(error.name==='ZodError'?'INVALID_BILLING_INPUT':error.message)});return null}
}
const sub='11111111-1111-4111-8111-111111111111', order='22222222-2222-4222-8222-222222222222', baseOrder='33333333-3333-4333-8333-333333333333'
const actor={userId:'user',workspaceId:'workspace',workspaceRole:'owner',authentication:{kind:'session',sessionId:'session'},scopes:null}
const snapshot={workspaceId:'workspace',environment:'sandbox',subscriptionId:sub,plan:'starter',status:'active',updatedAt:'2027-01-02T00:00:00.000Z',currentPeriodStart:'2027-01-01T00:00:00.000Z',currentPeriodEnd:'2027-02-01T00:00:00.000Z',pastDueAt:null}
const event={eventId:'event',bodyHash:'a'.repeat(64),snapshot}
const active=await add('snapshot',event)
const receipt={workspaceId:'workspace',environment:'sandbox',subscriptionId:sub,bodyHash:event.bodyHash,eventId:'event',outcome:'applied'}
const proof={orderId:order,subscriptionId:sub,periodStart:snapshot.currentPeriodStart,periodEnd:snapshot.currentPeriodEnd,createdAt:'2027-01-10T00:00:00.000Z'}
const refund={workspaceId:'workspace',environment:'sandbox',orderId:order,subscriptionId:sub,start:snapshot.currentPeriodStart,end:snapshot.currentPeriodEnd,refundedAt:clock}
const refEvent={eventId:'refund',bodyHash:'b'.repeat(64),refund}
const marker={environment:'sandbox',orderId:order,subscriptionId:sub,start:refund.start,end:refund.end,refundedAt:clock}
const basis={orderId:baseOrder,start:refund.start,end:refund.end}
for(const previous of [null,{},active,{...active,plan:'business',paidUpgradeOrderId:order},{...active,sourceReference:baseOrder},{...active,providerEnvironment:'production'}]){
 for(const status of ['active','past_due','canceled'])for(const plan of ['starter','plus'])for(const cancelAtPeriodEnd of [false,true])for(const paidUpgrade of [undefined,proof]){
  const candidate={...snapshot,plan,status,cancelAtPeriodEnd,paidUpgrade,updatedAt:'2027-01-12T00:00:00.000Z',pastDueAt:status==='past_due'?'2027-01-10T00:00:00.000Z':null}
  await add('snapshot',{...event,snapshot:candidate},{previous})
 }
}
for(const previous of [active,{...active,terminatedAt:'2027-01-12T00:00:00.000Z'},{...active,unsupportedPauseAt:'2027-01-12T00:00:00.000Z'},{...active,status:'past_due',paymentFailedAt:'2027-01-10T00:00:00.000Z',graceExpiresAt:'2027-01-17T00:00:00.000Z'},{...active,refundedPeriods:[marker]},{...active,refundedPeriods:[{...marker,kind:'upgrade',starterOrderId:null}]}]){
 for(const updatedAt of ['2027-01-01T00:00:00.000Z',snapshot.updatedAt,'2027-01-13T00:00:00.000Z'])for(const patch of [{},{plan:'plus'},{plan:'plus',paidUpgrade:proof},{status:'past_due',pastDueAt:'2027-01-01T00:00:00.000Z'},{status:'past_due',pastDueAt:'2027-01-11T00:00:00.000Z'},{status:'canceled',cancelAtPeriodEnd:true},{status:'canceled',terminatedAt:'2027-01-01T00:00:00.000Z'},{unsupportedPauseAt:'2027-01-01T00:00:00.000Z'},{unsupportedPauseAt:snapshot.currentPeriodEnd}])for(const duplicate of [null,receipt])await add('snapshot',{...event,snapshot:{...snapshot,updatedAt,...patch}},{previous,receipt:duplicate})
}
for(const previous of [null,active,{...active,plan:'business'}, {...active,cancelAtPeriodEnd:true,cancellationPeriodEnd:'2027-01-25T00:00:00.000Z'}])for(const currentPeriodStart of [snapshot.currentPeriodStart,snapshot.currentPeriodEnd])for(const status of ['active','past_due','canceled'])await add('snapshot',{...event,snapshot:{...snapshot,currentPeriodStart,currentPeriodEnd:'2027-03-01T00:00:00.000Z',status,updatedAt:clock,pastDueAt:'2027-01-10T00:00:00.000Z',cancelAtPeriodEnd:true}},{previous})
for(const role of ['owner','admin',' member, admin ','member','guest','',null])for(const target of ['starter','plus'])for(const status of ['applied','scheduled','unchanged','payment-pending','cleared'])await add('snapshot',{...event,actor,planChange:{target,status,effectiveAt:snapshot.currentPeriodEnd,renewalSeats:5}},{previous:active,memberRole:role})
for(const patch of [{planChange:{target:'plus',status:'applied',effectiveAt:null,renewalSeats:1}},{actor:{...actor,workspaceId:'other'}},{actor:{...actor,workspaceRole:'member'}},{actor:{...actor,authentication:{kind:'apiKey',credentialId:'c'}}}])await add('snapshot',{...event,...patch})
for(const previous of [null,active])for(const patch of [{bodyHash:'BAD'},{eventId:''},{eventId:' x '},{eventId:'x'.repeat(256)}])await add('snapshot',{...event,...patch},{previous})
for(const field of ['workspaceId','environment','subscriptionId','plan','status','updatedAt','currentPeriodStart','currentPeriodEnd','pastDueAt','cancelAtPeriodEnd','terminatedAt','unsupportedPauseAt','paidUpgrade'])for(const value of [undefined,null,'bad',false,0])await add('snapshot',{...event,snapshot:{...snapshot,[field]:value}})
for(const patch of [{currentPeriodEnd:snapshot.currentPeriodStart},{terminatedAt:clock},{unsupportedPauseAt:'2027-01-20T00:00:00.000Z'},{paidUpgrade:{...proof,createdAt:snapshot.currentPeriodEnd},plan:'plus'},{paidUpgrade:{...proof,subscriptionId:baseOrder},plan:'plus'},{unknown:'stripped'}])await add('snapshot',{...event,snapshot:{...snapshot,...patch}})
for(const ctx of [{workspaceExists:false},{receipt:{...receipt,bodyHash:'c'.repeat(64)}},{receipt:{...receipt,workspaceId:'other'}},{receipt:{...receipt,subscriptionId:baseOrder}}]){await add('snapshot',event,ctx);await add('refund',refEvent,ctx)}
for(const previous of [null,{},active,{...active,plan:'business',paidUpgradeOrderId:order},{...active,plan:'business',paidUpgradeOrderId:baseOrder},{...active,sourceReference:baseOrder},{...active,currentPeriodStart:'2027-02-01T00:00:00.000Z',currentPeriodEnd:'2027-03-01T00:00:00.000Z'}])for(const kind of [undefined,'full','partial'])for(const scope of [undefined,'period','upgrade'])for(const starterBasis of [undefined,basis])await add('refund',{...refEvent,refund:{...refund,kind,scope,starterBasis}},{previous})
for(const history of [[marker],[{...marker,kind:'upgrade',starterOrderId:null}],[{...marker,kind:'upgrade',starterOrderId:baseOrder,basePeriodStart:refund.start,basePeriodEnd:refund.end}]])for(const duplicate of [null,{...receipt,bodyHash:refEvent.bodyHash}])for(const scope of ['period','upgrade'])for(const kind of ['full','partial'])for(const starterBasis of [undefined,basis,{...basis,orderId:sub}])await add('refund',{...refEvent,refund:{...refund,scope,kind,starterBasis}},{previous:{...active,plan:'business',paidUpgradeOrderId:order,refundedPeriods:history},receipt:duplicate})
for(const field of ['workspaceId','environment','orderId','subscriptionId','start','end','refundedAt','kind','scope','starterBasis'])for(const value of [undefined,null,'bad',false,0])await add('refund',{...refEvent,refund:{...refund,[field]:value}})
for(const patch of [{end:refund.start},{start:'2027-01-01T01:00:00.000+01:00'},{refundedAt:'2027-01-15T12:00+00:00'},{refundedAt:'2027-02-30T12:00:00Z'},{refundedAt:'2027-01-15T12:00:00.123456Z'},{refundedAt:'2027-01-15T12:00:00+23:59'},{unknown:'stripped'},{scope:'upgrade',starterBasis:{...basis,end:'2027-02-01T01:00:00+01:00'}},{scope:'upgrade',starterBasis:{...basis,start:'2027-01-02T00:00:00Z'}},{scope:'upgrade',starterBasis:{...basis,end:'2027-01-31T00:00:00Z'}}])for(const previous of [active,{...active,refundedPeriods:[marker]}])await add('refund',{...refEvent,refund:{...refund,...patch}},{previous})
// Verify replay promotion at exactly the original version, using the real prior hash.
const plusEvent={...event,snapshot:{...snapshot,plan:'plus',updatedAt:'2027-01-13T00:00:00.000Z'}}
const pending=await add('snapshot',plusEvent,{previous:active})
if(pending)await add('snapshot',{...plusEvent,snapshot:{...plusEvent.snapshot,paidUpgrade:proof}},{previous:pending,receipt})
// The restrictive cancellation expansion explicitly accepts a legacy state hash.
await add('snapshot',{...event,snapshot:{...snapshot,cancelAtPeriodEnd:true}},{previous:active})
const path=new URL('../rust/crates/forge-core/data/billing-state-reference.json',import.meta.url)
const output=JSON.stringify({cases},null,2)+'\n'
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error('Billing state fixtures are stale')}else writeFileSync(path,output)
console.log(`Billing state source fixtures: ${cases.length}`)
