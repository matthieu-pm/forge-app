// Source-owned provider orchestration, bounded ECB parsing and V8 Date coercion.
// Only injected in-memory boundaries run: no provider, network or database I/O.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as authorization from '../apps/forge/src/application/authorization.ts'
process.env.TZ = 'UTC'
mock.module('@tanstack/react-start/server-only', () => ({}))
mock.module('@/application/authorization', () => authorization)
for (const [file, name] of [['subscription-reconciliation.server.ts', 'applyVerifiedSubscriptionSnapshot'], ['subscription-refund.server.ts', 'applyVerifiedPeriodRefund']]) mock.module(new URL(`../apps/forge/src/application/billing/${file}`, import.meta.url).pathname, () => ({ [name]: () => { throw Error('Unexpected persistent effect') } }))
const { fetchEcbReferenceRate } = await import('../apps/forge/src/application/billing/ecb-reference-rate.server.ts')
const { PolarSubscriptionRefundReconciler } = await import('../apps/forge/src/application/billing/polar-subscription-refund.server.ts')
const { PolarReplacementAnniversaryVerifier } = await import('../apps/forge/src/application/billing/polar-replacement-anniversary.server.ts')
const copy = value => JSON.parse(JSON.stringify(value))
const errorCode = error => ['ZodError','TypeError','RangeError'].includes(error.name) ? 'INVALID_BILLING_INPUT' : (error.code ?? error.message)
const config = { enabled: true, environment: 'sandbox', accessToken: 'fixture-token', webhookSecret: 'fixture-secret', appUrl: 'https://forge.example.test', paidProducts: { starter: { usd: '00000000-0000-4000-8000-000000000001', eur: '00000000-0000-4000-8000-000000000002' }, plus: { usd: '00000000-0000-4000-8000-000000000003', eur: '00000000-0000-4000-8000-000000000004' } } }
const actor = { workspaceId: 'w1', userId: 'owner', workspaceRole: 'owner', scopes: null, authentication: { kind: 'session', sessionId: 'fixture' } }
const source = '00000000-0000-4000-8000-000000000010', replacement = '00000000-0000-4000-8000-000000000011', requestId = '00000000-0000-4000-8000-000000000012', orderId = '00000000-0000-4000-8000-000000000013', checkoutId = '00000000-0000-4000-8000-000000000014'
const cases = []
function finish(input, trace, result) { cases.push({ ...input, trace, ...result }) }
function bytes(body) { if (body === null) return null; if (body.base64 !== undefined) return Buffer.from(body.base64, 'base64'); return Buffer.concat([Buffer.from(body.prefix ?? ''), Buffer.alloc(body.count ?? 0, body.byte ?? 32), Buffer.from(body.suffix ?? '')]) }
const body = text => ({ base64: Buffer.from(text).toString('base64') })
const xml = `<gesmes:Envelope xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube><Cube time='2027-01-14'><Cube currency='USD' rate='1.1133'/></Cube></Cube></gesmes:Envelope>`
async function ecb(name, patch = {}) {
 const input = copy({ kind: 'ecb', name, now: '2027-01-15T12:00:00.000Z', response: { status: 200, body: body(xml) }, ...patch }), trace = []
 const fetcher = async (url, options) => { trace.push({ kind: 'feed' }); if (input.response.error) throw Error(input.response.error); input.request = { url, redirect: options.redirect, cache: options.cache, headers: options.headers }; return new Response(bytes(input.response.body), { status: input.response.status }) }
 const clock = () => { trace.push({ kind: 'clock' }); return new Date(input.now) }
 try { finish(input, trace, { valid: true, output: await fetchEcbReferenceRate(fetcher, clock) }) } catch (error) { finish(input, trace, { valid: false, error: errorCode(error) }) }
}
await ecb('ecb/baseline')
for (const status of [201, 301, 400, 429, 503]) await ecb(`ecb/status/${status}`, { response: { status, body: body(xml) } })
for (const status of [200, 204]) await ecb(`ecb/missing-body/${status}`, { response: { status, body: null } })
await ecb('ecb/outage', { response: { error: 'BILLING_FX_SOURCE_UNAVAILABLE' } })
for (const [name, text] of [
 ['doctype', '<!DOCTYPE unsafe>'+xml], ['entity', '<!entity unsafe>'+xml], ['truncated', xml.slice(0,-20)], ['namespace', xml.replace('http://www.ecb.int/vocabulary/2002-08-01/eurofxref','https://wrong.test')], ['no-usd', xml.replace('USD','GBP')], ['duplicate-usd', xml.replace("<Cube currency='USD'", "<Cube currency='USD' rate='2'/><Cube currency='USD'")], ['duplicate-date', xml.replace('</gesmes:Envelope>',"<Cube time='2027-01-14'></Cube></gesmes:Envelope>")], ['usd-outside-date', xml.replace("<Cube currency='USD' rate='1.1133'/>",'').replace('</gesmes:Envelope>',"<Cube currency='USD' rate='1.1133'/></gesmes:Envelope>")], ['trailing-garbage',xml+'x'], ['bom','\uFEFF'+xml], ['nbsp',xml.replace('Cube time','Cube\u00a0time')], ['nel',xml.replace('Cube time','Cube\u0085time')], ['bom-space',xml.replace('Cube time','Cube\uFEFFtime')], ['trailing-nel',xml+'\u0085'], ['trailing-bom',xml+'\uFEFF'], ['mismatched-quotes',xml.replace("time='2027-01-14'",'time=\'2027-01-14"')],
]) await ecb(`ecb/xml/${name}`, { response: { status: 200, body: body(text) } })
await ecb('ecb/invalid-utf8', { response: { status: 200, body: { base64: Buffer.concat([Buffer.from(xml),Buffer.from([255])]).toString('base64') } } })
for (const rate of ['0','-1','0.00000000','0.00000001','1','99999999.99999999','100000000','1.000000001','01.1','1e0','0x10','Infinity','NaN',' ','']) await ecb(`ecb/rate/${JSON.stringify(rate)}`, { response: { status: 200, body: body(xml.replace('1.1133',rate)) } })
for (const reference of ['2027-01-08','2027-01-09','2027-01-15','2027-01-16','2027-13-01','2027-02-30']) await ecb(`ecb/date/${reference}`, { response: { status: 200, body: body(xml.replace('2027-01-14',reference)) } })
await ecb('ecb/rolled-invalid-date-before-schema', { now: '2027-03-03T00:00:00.000Z', response: { status: 200, body: body(xml.replace('2027-01-14','2027-02-30')) } })
for (const now of ['2027-01-21T00:00:00.000Z','2027-01-21T00:00:00.001Z','2027-01-14T00:00:00.000Z','2027-01-13T23:59:59.999Z']) await ecb(`ecb/freshness/${now}`, { now })
for (const size of [65536,65537]) await ecb(`ecb/limit/${size}`, { response: { status: 200, body: { prefix: xml, byte:32, count:size-Buffer.byteLength(xml) } } })

const refundId = '00000000-0000-4000-8000-000000000099', subId = '00000000-0000-4000-8000-000000000098', baseId = '00000000-0000-4000-8000-000000000097'
const start = '2027-01-01T00:00:00.000Z', end = '2027-02-01T00:00:00.000Z'
const refunded = { id: refundId, status:'refunded', net_amount:1600, tax_amount:320, total_amount:1920, refunded_amount:1600, refunded_tax_amount:320, applied_balance_amount:0, billing_reason:'subscription_cycle', currency:'usd', product_id:config.paidProducts.plus.usd, subscription_id:subId, modified_at:'2027-01-15T12:00:00.000Z', customer:{external_id:'forge:workspace:w1'}, items:[{amount:1600,tax_amount:320,proration:false,start_timestamp:start,end_timestamp:end}] }
const upgrade = { ...refunded, billing_reason:'subscription_update', items:[{...refunded.items[0],proration:true,start_timestamp:'2027-01-10T00:00:00.000Z'}] }
const base = { id:baseId,status:'paid',paid:true,net_amount:1000,tax_amount:200,total_amount:1200,due_amount:1200,applied_balance_amount:0,refunded_amount:0,refunded_tax_amount:0,billing_reason:'subscription_create',currency:'usd',product_id:config.paidProducts.starter.usd,subscription_id:subId,created_at:start,customer:{external_id:'forge:workspace:w1'},items:[{amount:1000,tax_amount:200,proration:false,start_timestamp:start,end_timestamp:end}] }
async function refund(name, patch = {}) {
 const input = copy({kind:'refund',name,input:{workspaceId:'w1',orderId:refundId,eventId:'refund-event',bodyHash:'a'.repeat(64)},order:refunded,pages:[{value:{items:[base],pagination:{max_page:1}}}],basisLookup:true,renew:true,result:{outcome:'applied',replayed:false},...patch}),trace=[]
 let page=0
 const get=async id=>{trace.push({kind:'order',id});if(input.getError)throw Error(input.getError);return copy(input.order)}
 const list=async query=>{trace.push({kind:'orders',query:copy(query)});const item=input.pages[page++];if(!item)throw Error('UNEXPECTED_PROVIDER_REQUEST');if(item.error)throw Error(item.error);return copy(item.value)}
 const apply=async event=>{trace.push({kind:'apply',event:copy(event)});if(input.applyError)throw Error(input.applyError);return copy(input.result)}
 const renew=async identity=>{trace.push({kind:'renew',identity:copy(identity)});if(input.renewError)throw Error(input.renewError);return {status:'scheduled',replayed:false}}
 const service = new PolarSubscriptionRefundReconciler(config,{orders:{get,...(input.basisLookup?{list}:{})}},apply,input.renew?renew:undefined)
 try{finish(input,trace,{valid:true,output:copy(await service.reconcile(input.input))})}catch(error){finish(input,trace,{valid:false,error:errorCode(error)})}
}
await refund('refund/full-period')
await refund('refund/full-upgrade',{order:upgrade})
for(const order of [refunded,upgrade])for(const renew of [true,false])for(const basisLookup of [true,false])await refund(`refund/capabilities/${order.billing_reason}/${renew}/${basisLookup}`,{order,renew,basisLookup})
for(const order of [refunded,upgrade])await refund(`refund/partial/${order.billing_reason}`,{order:{...order,status:'partially_refunded',refunded_amount:100,refunded_tax_amount:20},renewError:'BILLING_REFUND_RENEWAL_NOT_CONFIRMED'})
for(const page of [{value:{items:[],pagination:{max_page:1}}},{error:'BILLING_PROVIDER_UNAVAILABLE'},{value:{items:[{...base,paid:false}],pagination:{max_page:1}}},{value:{items:[],pagination:null}}])for(const renewError of [undefined,'BILLING_REFUND_RENEWAL_NOT_CONFIRMED'])await refund(`refund/missing-base/${JSON.stringify(page)}/${renewError}`,{order:upgrade,pages:[page],renewError})
for(const [name,patch] of Object.entries({get:{getError:'BILLING_PROVIDER_UNAVAILABLE'},apply:{applyError:'BILLING_PERSISTENCE_UNAVAILABLE'},renew:{renewError:'BILLING_REFUND_RENEWAL_NOT_CONFIRMED'},replay:{result:{outcome:'duplicate',replayed:true}}}))await refund(`refund/effect/${name}`,{order:upgrade,...patch})
await refund('refund/base-page-three',{order:upgrade,pages:[{value:{items:[],pagination:{max_page:5}}},{value:{items:[{...base,paid:false}],pagination:{max_page:5}}},{value:{items:[base],pagination:{max_page:5}}}]})
await refund('refund/base-work-bounded',{order:upgrade,pages:Array.from({length:3},()=>({value:{items:[],pagination:{max_page:20}}}))})
for(const patch of [{id:baseId},{customer:{external_id:'forge:workspace:other'}},{product_id:baseId},{status:'paid'},{applied_balance_amount:1},{items:[]},{subscription_id:null}])await refund(`refund/invalid-proof/${JSON.stringify(patch)}`,{order:{...upgrade,...patch}})
await refund('refund/invalid-id-before-get',{input:{workspaceId:'w1',orderId:'bad',eventId:'refund-event',bodyHash:'a'.repeat(64)}})

const paid = '2027-02-05T20:00:00.000Z', paidEnd = '2027-03-05T20:00:00.000Z'
const context={requestId,workspaceId:'w1',environment:'sandbox',sourceSubscriptionId:source,targetCurrency:'eur',renewalPlan:'starter',renewalMembers:2,renewalPriceMinor:2000,originalPeriodStart:'2026-12-31T17:00:00.000Z',effectiveAt:'2027-01-31T17:00:00.000Z',anchorDay:31,nextRenewalAt:'2027-02-28T17:00:00.000Z',checkoutGraceEndsAt:'2027-02-07T17:00:00.000Z'}
const subscription={id:replacement,product_id:config.paidProducts.starter.eur,currency:'eur',customer:{external_id:'forge:workspace:w1'},status:'active',modified_at:paid,current_period_start:paid,current_period_end:paidEnd,recurring_interval:'month',recurring_interval_count:1,past_due_at:null,cancel_at_period_end:false,ends_at:null,ended_at:null,pause_at_period_end:false,paused_at:null,resumes_at:null,pending_update:null,trial_start:null,trial_end:null,amount:2000,seats:2}
const checkout={id:checkoutId,created_at:'2027-02-05T19:00:00.000Z',modified_at:paid,status:'succeeded',amount:2000,seats:2,discount_amount:0,net_amount:2000,tax_amount:400,tax_behavior:'exclusive',total_amount:2400,currency:'eur',product_id:config.paidProducts.starter.eur,allow_trial:false,trial_end:null,external_customer_id:'forge:workspace:w1',customer_billing_address:{country:'FR',line1:null,line2:null,postal_code:null,city:null,state:null},metadata:{currency_change_request_id:requestId,workspace_id:'w1',source_subscription_id:source},subscription_id:null}
const replacementOrder={id:orderId,checkout_id:checkoutId,subscription_id:replacement,product_id:config.paidProducts.starter.eur,currency:'eur',billing_reason:'subscription_create',status:'paid',paid:true,net_amount:2000,tax_amount:400,total_amount:2400,due_amount:2400,applied_balance_amount:0,refunded_amount:0,refunded_tax_amount:0,created_at:paid,customer:{external_id:'forge:workspace:w1'},items:[{proration:false,start_timestamp:paid,end_timestamp:paidEnd,amount:2000}]}
const dateKeys=['originalPeriodStart','effectiveAt','nextRenewalAt','checkoutGraceEndsAt']
const dates=value=>Object.fromEntries(Object.entries(value).map(([key,value])=>[key,dateKeys.includes(key)&&typeof value==='string'?new Date(value):value]))
async function replacementCase(name,patch={}){
 const input=copy({kind:'replacement',name,actor,requestId,orderId,contexts:[{value:context},{value:context}],subscription,checkout,order:replacementOrder,now:'2027-02-06T10:00:00.000Z',...patch}),trace=[];let index=0
 const resolve=async(actor,id)=>{trace.push({kind:'context',actor:copy(actor),id});const step=input.contexts[index++];if(!step)throw Error('UNEXPECTED_CONTEXT');if(step.error)throw Error(step.error);return dates(copy(step.value))}
 const get=async(kind,id)=>{trace.push({kind,id});if(input.errors?.[kind])throw Error(input.errors[kind]);return copy(input[kind])}
 const clock=()=>{trace.push({kind:'clock'});return new Date(input.now)}
 const verifier=new PolarReplacementAnniversaryVerifier(config,resolve,{orders:{get:id=>get('order',id)},subscriptions:{get:id=>get('subscription',id)},checkouts:{get:id=>get('checkout',id)}},clock)
 try{finish(input,trace,{valid:true,output:copy(await verifier.plan(input.actor,input.requestId,input.orderId))})}catch(error){finish(input,trace,{valid:false,error:errorCode(error)})}
}
await replacementCase('replacement/baseline')
await replacementCase('replacement/already-aligned',{subscription:{...subscription,current_period_end:context.nextRenewalAt}})
for(const patch of [{status:'confirmed'},{currency:'usd'},{seats:3},{allow_trial:true},{trial_end:'2027-02-20T00:00:00Z'},{discount_amount:1},{tax_behavior:'inclusive'},{tax_behavior:null},{external_customer_id:'forge:workspace:other'},{subscription_id:source},{subscription_id:replacement},{metadata:{workspace_id:'w1'}},{metadata:null},{customer_billing_address:null},{customer_billing_address:{country:'US'}},{modified_at:'2027-02-06T11:00:00Z'},{created_at:'2027-02-05T21:00:00Z'},{tax_amount:399},{total_amount:2399},{amount:1999}])await replacementCase(`replacement/checkout/${JSON.stringify(patch)}`,{checkout:{...checkout,...patch}})
for(const key of ['trial_end','subscription_id','metadata','customer_billing_address']){const missing={...checkout};delete missing[key];await replacementCase(`replacement/checkout-missing/${key}`,{checkout:missing})}
for(const patch of [{paid:false},{status:'pending'},{due_amount:1},{refunded_amount:1},{billing_reason:'subscription_cycle'},{net_amount:1999},{total_amount:2000},{product_id:config.paidProducts.plus.eur},{customer:{external_id:'forge:workspace:other'}},{items:[]},{items:null},{items:[{...replacementOrder.items[0],proration:true}]},{items:[{...replacementOrder.items[0],end_timestamp:context.nextRenewalAt}]},{items:[{...replacementOrder.items[0],amount:1000},{...replacementOrder.items[0],amount:1000}]},{created_at:'2027-02-05T18:00:00Z'},{created_at:'bad'},{id:source},{subscription_id:source},{subscription_id:null},{checkout_id:'bad'},{applied_balance_amount:-2400,due_amount:0}])await replacementCase(`replacement/order/${JSON.stringify(patch)}`,{order:{...replacementOrder,...patch}})
for(const patch of [{status:'past_due',past_due_at:paid},{pause_at_period_end:true},{cancel_at_period_end:true},{amount:1600},{seats:1},{trial_start:paid},{current_period_start:'2027-01-31T16:59:59Z'},{current_period_start:'2027-02-07T17:00:00Z'},{current_period_end:'2027-03-06T20:00:00Z'},{modified_at:'2027-02-04T20:00:00Z'},{modified_at:'2027-02-06T11:00:00Z'},{customer:{external_id:'forge:workspace:other'}},{pending_update:{seats:3}}])await replacementCase(`replacement/subscription/${JSON.stringify(patch)}`,{subscription:{...subscription,...patch}})
for(const key of ['resumes_at','ends_at','ended_at','pending_update','trial_start','trial_end']){const missing={...subscription};delete missing[key];await replacementCase(`replacement/subscription-missing/${key}`,{subscription:missing})}
for(const patch of [{workspaceId:'other'},{environment:'production'},{requestId:source},{renewalMembers:3},{renewalPriceMinor:1999},{anchorDay:30},{originalPeriodStart:null},{nextRenewalAt:'bad'},{sourceSubscriptionId:'bad'},{renewalMembers:Number.MAX_SAFE_INTEGER},{workspaceId:'other',renewalMembers:Number.MAX_SAFE_INTEGER},{ignored:'new'}])for(const index of [0,1]){const contexts=[{value:context},{value:context}];contexts[index]={value:{...context,...patch}};await replacementCase(`replacement/context/${index}/${JSON.stringify(patch)}`,{contexts})}
for(const index of [0,1]){const contexts=[{value:context},{value:context}];contexts[index]={error:'BILLING_ACTOR_REVOKED'};await replacementCase(`replacement/revoked/${index}`,{contexts})}
for(const kind of ['order','subscription','checkout'])await replacementCase(`replacement/provider-failure/${kind}`,{errors:{[kind]:'BILLING_PROVIDER_UNAVAILABLE'}})
for(const workspaceRole of ['member','guest','admin',' member, admin '])await replacementCase(`replacement/role/${workspaceRole}`,{actor:{...actor,workspaceRole}})
await replacementCase('replacement/api-key',{actor:{...actor,authentication:{kind:'apiKey',credentialId:'key'}}})
for(const field of ['requestId','orderId'])await replacementCase(`replacement/invalid-${field}`,{[field]:'bad'})
for(const now of ['2027-02-05T19:59:59.999Z','2027-02-28T17:00:00.000Z'])await replacementCase(`replacement/clock/${now}`,{now})

// The owning provider mutation adapters call new Date(pending.applies_at).
// Pin UTC V8 semantics independently of Bun's generator runtime.
const dateInputs=[{missing:true},...[
 null,false,true,0,1,-1,1.9,-1.9,8640000000000000,8640000000000001,-8640000000000000,
 '', ' ', '0','1','12','13','31','32','49','50','99','100','999','0000','0001','2027','2027-02','2027-02-28','2027-02-30','2027-04-31','2027-01-32','2027-00-01',
 '2027-02-28T00:00:00Z','2027-02-28T00:00Z','2027-02-28T00:00:00.123456Z','2027-02-28T24:00:00.000Z','2027-02-28T24:00:00.001Z','2027-02-28T23:59:60Z','2027-02-28T00:00:00+05:30','2027-02-28T00:00:00-0230','2027-02-28T00:00:00+24:00','2027-02-28T00:00:00',
 '2027-02-28 00:00:00','2027-02-28t00:00:00z','2027-02-28Z','2027-02Z','2027Z',' 2027-02-28T00:00:00Z ','\uFEFF2027-02-28',
 '+002027-02-28T00:00:00Z','-000001-01-01T00:00:00Z','-000000-01-01T00:00:00Z','+275760-09-13T00:00:00.000Z','+275760-09-13T00:00:00.001Z',
 'Sun, 28 Feb 2027 00:00:00 GMT','02/28/2027','2027/02/28','Feb 28 2027','February 28 2027','2/30/2027','not-a-date',[],[null],[0],[1],[2027,2,28],['2027-02-28'],[['2027-02-28']],{},[{}],
].map(value=>({value}))]
const dateSource=`import {readFileSync} from 'node:fs';const inputs=JSON.parse(readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(inputs.map(input=>{const d=new Date(input.missing?undefined:input.value);return {...input,output:Number.isFinite(+d)?d.toISOString():null,timestampMillis:Number.isFinite(+d)?+d:null}})))`
const result=spawnSync('node',['--input-type=module','-e',dateSource],{input:JSON.stringify(dateInputs),encoding:'utf8',env:{...process.env,TZ:'UTC'}})
if(result.status!==0)throw Error(result.stderr||'V8 date reference failed')
for(const [index,item] of JSON.parse(result.stdout).entries())cases.push({kind:'date',name:`date/${index}`,input:item.missing?{missing:true}:{value:item.value},valid:true,output:item.output,timestampMillis:item.timestampMillis,trace:[]})
const output=JSON.stringify({config,cases},null,2)+'\n',path=new URL('../rust/crates/forge-core/data/billing-misc-reference.json',import.meta.url)
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error('Billing miscellaneous provider reference changed')}else writeFileSync(path,output)
console.log(`Billing miscellaneous reference: ${cases.length} source cases (${Object.entries(cases.reduce((out,item)=>(out[item.kind]=(out[item.kind]??0)+1,out),{})).map(([k,n])=>`${k}:${n}`).join(', ')})`)
