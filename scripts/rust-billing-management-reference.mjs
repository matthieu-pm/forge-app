// Owning read/transaction functions, deterministic clock, no provider or database I/O.
import { mock } from 'bun:test'
import { readFileSync,writeFileSync } from 'node:fs'
import { pgTable,text } from '../apps/forge/node_modules/drizzle-orm/pg-core/index.js'
import * as authorization from '../apps/forge/src/application/authorization.ts'
const clock='2027-01-15T12:00:00.000Z',NativeDate=Date
let currentClock=clock
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[currentClock]))}static now(){return +new NativeDate(currentClock)}}
const columns=names=>Object.fromEntries(names.map(n=>[n,text(n)]))
const tables={organizations:pgTable('organization',columns(['id'])),members:pgTable('member',columns(['role','organizationId','userId'])),workspaceEntitlements:pgTable('workspace_entitlements',columns(['workspaceId'])),billingEventReceipts:pgTable('billing_event_receipts',columns(['environment','eventId'])),workspaceSecurityAuditEvents:pgTable('workspace_security_audit_events',columns(['id'])),workspaceMemberCapacity:pgTable('workspace_member_capacity',columns(['workspaceId'])),workspaceCurrencyChangeRequests:pgTable('workspace_currency_change_requests',columns(['id','workspaceId','state']))}
const names=new Map([[tables.workspaceCurrencyChangeRequests,'currency'],[tables.billingEventReceipts,'receipt'],[tables.workspaceSecurityAuditEvents,'audit']])
const defaults={plan:'free',status:'active',source:'internal',sourceReference:null,providerEnvironment:null,providerUpdatedAt:null,providerStateHash:null,trialRedemptionId:null,paidUpgradeOrderId:null,terminatedAt:null,unsupportedPauseAt:null,paidActivatedAt:null,paymentFailedAt:null,graceExpiresAt:null,currentPeriodStart:null,currentPeriodEnd:null,cancelAtPeriodEnd:false,cancellationPeriodEnd:null,refundedPeriods:[],updatedAt:clock}
const keys=['providerUpdatedAt','updatedAt','terminatedAt','unsupportedPauseAt','paidActivatedAt','paymentFailedAt','graceExpiresAt','currentPeriodStart','currentPeriodEnd','cancellationPeriodEnd','effectiveAt','originalPeriodStart','nextRenewalAt','checkoutGraceEndsAt','requestedAt']
const dates=v=>v===null?null:Object.fromEntries(Object.entries(v).map(([k,x])=>[k,keys.includes(k)&&typeof x==='string'?new Date(x):x]))
const json=v=>JSON.parse(JSON.stringify(v))
let context,commands
const returning=values=>dates({...json(values),...Object.fromEntries(['id','subscriptionId'].filter(k=>typeof values[k]==='string').map(k=>[k,values[k].toLowerCase()]))})
function deferred(run){let done=false,result;const once=()=>{if(!done){result=run();done=true}return result};return{then:resolve=>resolve(once()),returning:async()=>[once()]}}
const db={
 query:{workspaceEntitlements:{findFirst:async()=>dates(context.previous)},billingEventReceipts:{findFirst:async()=>context.receipt},members:{findFirst:async()=>context.memberRole==null?null:{role:context.memberRole}},workspaceMemberCapacity:{findFirst:async()=>context.capacity},workspaceCurrencyChangeRequests:{findFirst:async()=>dates(context.receipt?context.requested:context.pending)}},
 select:selection=>({from:table=>({where:()=>{const rows=()=>table===tables.organizations?(context.workspaceExists?[{id:'workspace'}]:[]):Object.hasOwn(selection,'total')?[{total:context.memberCount}]:context.memberRole==null?[]:[{role:context.memberRole}];return{for:async()=>rows(),then:resolve=>resolve(rows())}}})}),
 insert:table=>({values:values=>deferred(()=>{commands.push({operation:names.get(table)+'_insert',values:json(values)});return returning(values)})}),
 update:table=>({set:set=>({where:()=>deferred(()=>{const row=set.originalPeriodStart?context.requested:context.pending;commands.push({operation:names.get(table)+'_update',id:row.id,set:json(set)});return dates({...row,...json(set)})})})}),
 transaction:async fn=>fn(db),
}
mock.module('@tanstack/react-start/server-only',()=>({}))
mock.module('@/application/authorization',()=>authorization)
mock.module('@/application/features/features.server',()=>({requireFeatureWrite:()=>{throw Error('Fixture does not invoke public writes')}}))
mock.module(new URL('../apps/forge/src/application/billing/polar-plan-change.server.ts',import.meta.url).pathname,()=>({PolarPlanChanger:class{}}))
mock.module('@/db',()=>({...tables,db}))
const {readCancellationContext}=await import('../apps/forge/src/application/billing/subscription-cancellation-context.server.ts')
const {readPlanChangeContext}=await import('../apps/forge/src/application/billing/plan-change-context.server.ts')
const {countBillableWorkspaceMembers}=await import('../apps/forge/src/application/billing/billable-members.server.ts')
const {readUpgradeRefundRenewalContext,confirmUpgradeRefundRenewal}=await import('../apps/forge/src/application/billing/upgrade-refund-renewal-context.server.ts')
const {recordVerifiedRenewalCurrencyRequest}=await import('../apps/forge/src/application/billing/renewal-currency-request.server.ts')
const cases=[]
async function add(kind,input,ctx={}){
 context={now:clock,workspaceExists:true,previous:null,receipt:null,memberRole:'owner',memberCount:2,capacity:{activeMemberCount:2},requested:null,pending:null,...json(ctx)}
 if(context.previous!==null)context.previous={...defaults,...context.previous}
 currentClock=context.now;commands=[];const item={kind,input:json(input),context};let args=json(input)
 if(kind==='currency')args.value=Object.fromEntries(Object.entries(args.value).map(([k,v])=>[k,['periodStart','periodEnd','providerUpdatedAt'].includes(k)&&typeof v==='string'?new Date(v):v]))
 try{let answer;
  if(kind==='cancellation')answer=await readCancellationContext(args.actor,args.environment)
  if(kind==='plan-change')answer=await readPlanChangeContext(args.actor,args.environment)
  if(kind==='members')answer=await countBillableWorkspaceMembers(args.actor)
  if(kind==='refund-context')answer=await readUpgradeRefundRenewalContext(args.value)
  if(kind==='refund-confirmation')answer=await confirmUpgradeRefundRenewal(args.value,args.proof)
  if(kind==='currency')answer=await recordVerifiedRenewalCurrencyRequest(args.actor,args.value)
  const output=['currency','refund-confirmation'].includes(kind)?{commands,answer}:answer
  cases.push({...item,valid:true,output:json(output)});return json(output)
 }catch(error){cases.push({...item,valid:false,error:error.code??(error.name==='ZodError'?'INVALID_BILLING_INPUT':error.message)});return null}
}
const sub='11111111-1111-4111-8111-111111111111',order='22222222-2222-4222-8222-222222222222',id='abcdefab-cdef-4def-8def-abcdefabcdef',product='33333333-3333-4333-8333-333333333333'
const actor={userId:'user',workspaceId:'workspace',workspaceRole:'owner',authentication:{kind:'session',sessionId:'session'},scopes:null}
const start='2027-01-01T00:00:00.000Z',end='2027-02-01T00:00:00.000Z'
const active={...defaults,plan:'basic',status:'active',source:'polar',sourceReference:sub,providerEnvironment:'sandbox',providerUpdatedAt:'2027-01-02T00:00:00.000Z',paidActivatedAt:start,currentPeriodStart:start,currentPeriodEnd:end}
const marker={environment:'sandbox',subscriptionId:sub,orderId:order,kind:'upgrade',starterOrderId:product,start,end,refundedAt:clock,basePeriodStart:start,basePeriodEnd:end}
const refunded={...active,refundedPeriods:[marker]}
const identity={workspaceId:'workspace',environment:'sandbox',subscriptionId:sub,orderId:order}
const request={requestId:id,workspaceId:'workspace',environment:'sandbox',subscriptionId:sub,billingCountry:'FR',fromCurrency:'usd',currentPlan:'starter',renewalPlan:'starter',periodStart:start,periodEnd:end,providerUpdatedAt:clock}
for(const previous of [null,{},active,{...active,sourceReference:'bad'},{...active,providerEnvironment:'production'},{...active,status:'past_due'},{...active,terminatedAt:clock},{...active,unsupportedPauseAt:end},{...active,currentPeriodEnd:start},{...active,plan:'business'},refunded])for(const memberRole of [null,'owner','admin','member',' member, admin '])for(const capacity of [null,{activeMemberCount:0},{activeMemberCount:4}])for(const kind of ['cancellation','plan-change'])await add(kind,{actor,environment:'sandbox'},{previous,memberRole,capacity})
for(const memberCount of [0,1,5,-1,1.5,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,null])await add('members',{actor},{memberCount})
for(const workspaceRole of ['owner','admin','member','guest',''])for(const authentication of [actor.authentication,{kind:'apiKey',credentialId:'c'}])for(const kind of ['cancellation','plan-change','members','currency'])await add(kind,{actor:{...actor,workspaceRole,authentication},environment:'sandbox',value:request},{previous:active})
for(const previous of [null,{},active,refunded,{...refunded,source:'internal'},{...refunded,sourceReference:product},{...refunded,providerEnvironment:'production'},{...refunded,terminatedAt:clock},{...refunded,unsupportedPauseAt:end},{...refunded,paidUpgradeOrderId:product},{...refunded,paidUpgradeOrderId:order},{...refunded,currentPeriodStart:end,currentPeriodEnd:'2027-03-01T00:00:00.000Z'},{...refunded,currentPeriodStart:'2027-01-02T00:00:00.000Z'},{...refunded,currentPeriodEnd:'2027-02-02T00:00:00.000Z'},{...refunded,currentPeriodStart:null},{...refunded,refundedPeriods:[{...marker,start:'bad'}]}])await add('refund-context',{value:identity},{previous})
const renewal=await add('refund-context',{value:identity},{previous:refunded})
const proof={revision:renewal.revision,effectiveAt:end,providerUpdatedAt:clock,currency:'usd',productId:product,billedSeats:2,renewalSeats:3,status:'scheduled'}
const confirmed=await add('refund-confirmation',{value:identity,proof},{previous:refunded})
const receipt=confirmed.commands.find(c=>c.operation==='receipt_insert').values
for(const previous of [refunded,{...refunded,terminatedAt:clock},{...refunded,unsupportedPauseAt:end},{...refunded,paidUpgradeOrderId:product},{...refunded,refundedPeriods:[{...marker,refundedAt:'2027-01-14T12:00:00.000Z'}]}])for(const duplicate of [null,receipt,{...receipt,bodyHash:'f'.repeat(64)}])for(const status of ['scheduled','already-starter'])await add('refund-confirmation',{value:identity,proof:{...proof,status}},{previous,receipt:duplicate})
for(const field of Object.keys(proof))for(const value of [undefined,null,'bad',0,-1,1.5])await add('refund-confirmation',{value:identity,proof:{...proof,[field]:value}},{previous:refunded})
for(const patch of [{effectiveAt:'2027-02-01T01:00:00+01:00'},{providerUpdatedAt:'2027-01-15T13:00:00+01:00'},{effectiveAt:start},{revision:'f'.repeat(64)},{extra:true},{renewalSeats:Number.MAX_SAFE_INTEGER}])await add('refund-confirmation',{value:identity,proof:{...proof,...patch}},{previous:refunded})
for(const field of Object.keys(identity))for(const value of [undefined,null,'bad',0])for(const kind of ['refund-context','refund-confirmation'])await add(kind,{value:{...identity,[field]:value},proof},{previous:refunded})
const created=await add('currency',{actor,value:request},{previous:active})
const currencyReceipt=created.commands.find(c=>c.operation==='receipt_insert').values
const requested=created.commands.find(c=>c.operation==='currency_insert').values
for(const billingCountry of ['FR','US',' jp ','DE','GB','AQ','bad'])for(const fromCurrency of ['eur','usd'])for(const renewalPlan of ['starter','plus'])for(const capacity of [null,{activeMemberCount:1},{activeMemberCount:6},{activeMemberCount:0},{activeMemberCount:Number.MAX_SAFE_INTEGER}])await add('currency',{actor,value:{...request,billingCountry,fromCurrency,renewalPlan}},{previous:active,capacity})
for(const previous of [null,{},active,{...active,sourceReference:product},{...active,providerEnvironment:'production'},{...active,unsupportedPauseAt:end},{...active,terminatedAt:clock},{...active,status:'past_due'},{...active,plan:'business'},{...active,currentPeriodStart:'2027-01-02T00:00:00.000Z'},{...active,providerUpdatedAt:'2027-01-16T00:00:00.000Z'}])for(const duplicate of [null,currencyReceipt])await add('currency',{actor,value:request},{previous,receipt:duplicate,requested})
for(const row of [null,requested,{...requested,workspaceId:'other'},{...requested,originalPeriodStart:null,billingAnchorDay:null,nextRenewalAt:null},{...requested,billingAnchorDay:31},{...requested,nextRenewalAt:null},{...requested,originalPeriodStart:'2027-01-02T00:00:00.000Z'}])for(const memberRole of ['owner','member',null])await add('currency',{actor,value:{...request,providerUpdatedAt:'2027-01-16T00:00:00.000Z'}},{previous:active,receipt:currencyReceipt,requested:row,memberRole})
for(const pending of [requested,{...requested,subscriptionId:product},{...requested,environment:'production'},{...requested,effectiveAt:'2027-03-01T00:00:00.000Z'}])for(const billingCountry of ['FR','US'])await add('currency',{actor,value:{...request,requestId:product,billingCountry}},{previous:active,pending})
for(const field of Object.keys(request))for(const value of [undefined,null,'bad',false,0])await add('currency',{actor,value:{...request,[field]:value}},{previous:active})
for(const patch of [{requestId:id.toUpperCase()},{billingCountry:' fr '},{periodStart:end},{periodEnd:'2027-02-02T00:00:00.000Z'},{extra:'stripped'}])await add('currency',{actor,value:{...request,...patch}},{previous:active})
for(const ctx of [{workspaceExists:false},{receipt:{...currencyReceipt,bodyHash:'f'.repeat(64)}},{receipt:{...currencyReceipt,workspaceId:'other'}},{receipt:{...currencyReceipt,subscriptionId:product}}])await add('currency',{actor,value:request},{previous:active,requested,...ctx})
for(const patch of [{workspaceId:'other'},{workspaceRole:'member'}])await add('currency',{actor:{...actor,...patch},value:request},{previous:active})
for(const [periodStart,periodEnd,now] of [['2027-01-31T12:05:06.789Z','2027-02-28T12:05:06.789Z','2027-02-15T12:05:06.789Z'],['2028-01-31T12:05:06.789Z','2028-02-29T12:05:06.789Z','2028-02-15T12:05:06.789Z'],['2027-02-28T12:05:06.789Z','2027-03-31T12:05:06.789Z','2027-03-15T12:05:06.789Z']])await add('currency',{actor,value:{...request,periodStart,periodEnd,providerUpdatedAt:now}},{now,previous:{...active,currentPeriodStart:periodStart,currentPeriodEnd:periodEnd,paidActivatedAt:periodStart,providerUpdatedAt:periodStart}})
const path=new URL('../rust/crates/forge-core/data/billing-management-reference.json',import.meta.url),out=JSON.stringify({cases},null,2)+'\n'
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==out)throw Error('Billing management fixtures are stale')}else writeFileSync(path,out)
console.log(`Billing management source fixtures: ${cases.length}`)
