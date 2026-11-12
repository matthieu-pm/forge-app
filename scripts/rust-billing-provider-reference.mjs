// Execute the owning reconciler and pinned SDK with recorded, in-memory I/O.
import { mock } from 'bun:test'
import { readFileSync,writeFileSync } from 'node:fs'
mock.module('@tanstack/react-start/server-only',()=>({}))
mock.module(new URL('../apps/forge/src/application/billing/subscription-reconciliation.server.ts',import.meta.url).pathname,()=>({applyVerifiedSubscriptionSnapshot:()=>{throw Error('Unexpected persistence')}}))
const {PolarSubscriptionReconciler}=await import('../apps/forge/src/application/billing/polar-subscription-reconciliation.server.ts')
const {findPaidStarterBasis}=await import('../apps/forge/src/application/billing/polar-paid-upgrade.server.ts')
const {createPolar}=await import('../apps/forge/node_modules/@polar-sh/sdk/dist/2026-10/index.mjs')
const json=v=>JSON.parse(JSON.stringify(v)),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const config={enabled:true,environment:'sandbox',accessToken:'fixture-token',webhookSecret:'fixture-secret',appUrl:'https://forge.test',paidProducts:{starter:{usd:id(1),eur:id(2)},plus:{usd:id(3),eur:id(4)}}}
const start='2027-01-01T00:00:00.000Z',end='2027-02-01T00:00:00.000Z'
const subscription={id:id(10),product_id:id(3),currency:'usd',status:'active',modified_at:'2027-01-15T00:00:00Z',created_at:start,current_period_start:start,current_period_end:end,recurring_interval:'month',recurring_interval_count:1,past_due_at:null,cancel_at_period_end:false,ends_at:null,ended_at:null,pause_at_period_end:false,paused_at:null,resumes_at:null,customer:{external_id:'forge:workspace:workspace'}}
const order={id:id(20),subscription_id:id(10),product_id:id(3),currency:'usd',billing_reason:'subscription_update',status:'paid',paid:true,net_amount:600,tax_amount:120,total_amount:720,due_amount:720,applied_balance_amount:0,refunded_amount:0,refunded_tax_amount:0,created_at:'2027-01-15T00:00:00Z',customer:subscription.customer,items:[{proration:true,start_timestamp:'2027-01-15T00:00:00Z',end_timestamp:end,amount:600}]}
const input={workspaceId:'workspace',subscriptionId:id(10),orderId:id(20),eventId:'evt.observation',bodyHash:'a'.repeat(64)}
const context={workspaceId:'workspace',subscriptionId:id(10),productId:id(1),currency:'usd',upgradeStart:'2027-01-15T00:00:00Z',periodEnd:end}
const base={...order,id:id(21),product_id:id(1),billing_reason:'subscription_create',created_at:start,items:[{proration:false,start_timestamp:start,end_timestamp:end,amount:1000}],net_amount:1000,tax_amount:200,total_amount:1200,due_amount:1200}
const cases=[]
async function add(name,patch={}){
 const c={name,kind:'subscription',input:json(input),subscription:json(subscription),order:json(order),pages:[{items:[json(order)],pagination:{max_page:1}}],hasOrders:true,fail:null,applyError:false,...json(patch)}
 const requests=[],applied=[];let page=0
 const get=async(kind,id)=>{requests.push({kind,id});if(c.fail===kind)throw Error('BILLING_PROVIDER_UNAVAILABLE');return json(c[kind])}
 const orders={get:id=>get('order',id),list:async query=>{requests.push({kind:'orders',query:json(query)});if(c.fail==='orders')throw Error('BILLING_PROVIDER_UNAVAILABLE');return json(c.pages[Math.min(page++,c.pages.length-1)])}}
 const client={subscriptions:{get:id=>get('subscription',id)},...(c.hasOrders?{orders}:{})}
 const sink=async event=>{applied.push(json(event));if(c.applyError)throw Error('BILLING_PERSISTENCE_UNAVAILABLE');return{changed:true}}
 const reconciler=new PolarSubscriptionReconciler(config,client,sink)
 try{
  const result=c.kind==='order'?await reconciler.reconcileOrder(c.input):c.kind==='starter'?await findPaidStarterBasis(orders,{...c.input,upgradeStart:new Date(c.input.upgradeStart),periodEnd:new Date(c.input.periodEnd)}):await reconciler.reconcile(c.input)
  c.valid=true;c.output=json(result??null)
 }catch(e){c.valid=false;c.error=e.name==='ZodError'||e.name==='TypeError'?'INVALID_BILLING_INPUT':e.message}
 c.requests=requests;c.applied=applied;cases.push(c)
}
await add('active Plus paid proof')
await add('order paid re-fetches current subscription',{kind:'order'})
for(const status of ['active','past_due','canceled','unpaid','paused'])for(const cancel of [false,true])for(const plan of ['starter','plus'])await add(`${plan} ${status} cancel=${cancel}`,{subscription:{...subscription,status,cancel_at_period_end:cancel,product_id:config.paidProducts[plan].usd,past_due_at:status==='past_due'?'2027-01-10T00:00:00Z':null,paused_at:status==='paused'?'2027-01-10T00:00:00Z':null}})
for(const patch of [{unsupportedResume:true},{workspaceId:'wrong'},{subscriptionId:'not-a-uuid'},{orderId:'invalid'}])for(const kind of ['subscription','order'])await add(`input ${JSON.stringify(patch)} ${kind}`,{kind,input:{...input,...patch}})
for(const s of [{pause_at_period_end:true},{paused_at:'2027-01-10T00:00:00Z'},{status:'canceled',ended_at:'2027-01-10T00:00:00Z'},{id:id(99)},{customer:{external_id:'wrong'}},{currency:'eur'},{recurring_interval:'year'},{status:'trialing'}])await add(`snapshot ${JSON.stringify(s)}`,{subscription:{...subscription,...s}})
for(const kind of ['subscription','order']){
 await add(`${kind} without order client`,{kind,hasOrders:false})
 for(const fail of ['subscription','order','orders'])await add(`${kind} ${fail} failure`,{kind,fail})
 await add(`${kind} persistence failure`,{kind,applyError:true})
}
for(const o of [{id:id(99)},{customer:{external_id:'wrong'}},{subscription_id:null},{subscription_id:id(99)}])await add(`order binding ${JSON.stringify(o)}`,{kind:'order',order:{...order,...o}})
await add('order response null',{kind:'order',order:null})
await add('order response null customer',{kind:'order',order:{...order,customer:null}})
for(const candidate of [null,{...order,customer:null},{...order,customer:undefined},{...order,items:[null]},{...order,items:[{...order.items[0],amount:'bad'},null]}])await add(`malformed candidate aborts before later proof ${cases.length}`,{pages:[{items:[candidate,order],pagination:{max_page:1}}]})
for(const pages of [
 [{items:[]}],
 [{items:[],pagination:null}],
 [{items:[],pagination:{}}],
 [{items:[order],pagination:null}],
 [{items:[],pagination:{max_page:1}}],
 [{items:[],pagination:{max_page:2}},{items:[order],pagination:{max_page:2}}],
 [{items:[{...order,paid:false}],pagination:{max_page:3}},{items:[{...order,refunded_amount:600,refunded_tax_amount:120,status:'refunded'}],pagination:{max_page:3}},{items:[order],pagination:{max_page:3}}],
 [{items:[],pagination:{max_page:4}},{items:[],pagination:{max_page:4}},{items:[],pagination:{max_page:4}},{items:[order],pagination:{max_page:4}}],
 [{items:[{...order,due_amount:0},{...order,product_id:id(1)},order],pagination:{max_page:1}}],
])await add(`bounded pages ${cases.length}`,{pages})
for(const pages of [
 [{items:[base],pagination:{max_page:1}}],
 [{items:[order,base],pagination:{max_page:1}}],
 [{items:[{...base,paid:false}],pagination:{max_page:3}},{items:[],pagination:{max_page:3}},{items:[base],pagination:{max_page:3}}],
 [{items:[],pagination:{max_page:8}}],
])await add(`starter basis ${cases.length}`,{kind:'starter',input:context,pages})
const wire=[];const savedFetch=globalThis.fetch
try{
 for(const environment of ['sandbox','production']){
  const sdk=createPolar({accessToken:config.accessToken,environment,timeout:15})
  for(const operation of ['product','subscription','order','orders','checkout','portal']){
   let request
   globalThis.fetch=async(url,options)=>{request={url:String(url),method:options.method,headers:Object.fromEntries(options.headers),body:options.body?JSON.parse(options.body):null};return new Response('{}',{status:200})}
   const body=operation==='checkout'?{products:[id(1)],seats:3,allow_trial:false}:operation==='portal'?{external_customer_id:'forge:workspace:workspace',return_url:'https://forge.test/settings/billing'}:null
   const query={product_id:id(3),external_customer_id:'forge:workspace:w +/?&語',subscription_id:id(10),status:['paid','partially_refunded'],created_before:end,page:2,limit:100,sorting:['-created_at']}
   if(operation==='product')await sdk.products.get(id(1))
   if(operation==='subscription')await sdk.subscriptions.get(id(10))
   if(operation==='order')await sdk.orders.get(id(20))
   if(operation==='orders')await sdk.orders.list(query)
   if(operation==='checkout')await sdk.checkouts.create(body)
   if(operation==='portal')await sdk.customerSessions.create(body)
   wire.push({environment,operation,id:operation==='product'?id(1):operation==='subscription'?id(10):id(20),body,query:operation==='orders'?Object.entries(query).flatMap(([k,v])=>(Array.isArray(v)?v:[v]).map(x=>[k,String(x)])):[],request})
  }
 }
}finally{globalThis.fetch=savedFetch}
const path=new URL('../rust/crates/forge-core/data/billing-provider-reference.json',import.meta.url),output=JSON.stringify({config,cases,wire},null,2)+'\n'
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error('Billing provider reference changed')}else writeFileSync(path,output)
console.log(`Billing provider reference: ${cases.length} reconciliations, ${wire.length} pinned SDK requests`)
