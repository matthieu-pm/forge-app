// Exercise the owning pure billing rules; no database, provider or credentials.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import * as authorization from '../apps/forge/src/application/authorization.ts'
import * as model from '../apps/forge/src/application/agents/model-contract.ts'
mock.module('@tanstack/react-start/server-only',()=>({}))
mock.module('@/application/authorization',()=>authorization)
mock.module('@/application/agents/model-contract',()=>model)
const root='../apps/forge/src/application/billing/'
const plans=await import(root+'billing-plan-contract.ts')
const countries=await import(root+'billing-country.ts')
const {readBillingConfig}=await import(root+'billing-config.server.ts')
const {workspaceBillingIdentity}=await import(root+'billing-authority.ts')
const {nextAnchoredMonth,captureMonthlyBillingAnchor,replacementAnniversarySchedule}=await import(root+'monthly-billing-anchor.ts')
const {workspaceUsagePeriod}=await import(root+'workspace-usage-period.ts')
const {trialExpiryCarryover}=await import(root+'trial-usage-carryover.ts')
const {paidToFreeCarryover}=await import(root+'paid-usage-carryover.ts')
const {resolveWorkspaceUsageAuthority,paidUsageBinding}=await import(root+'usage-authority.ts')
const {workspaceBillingNotices}=await import(root+'billing-notices.ts')
const {workspaceUsageChargePolicy,forgeBillableCostMicros}=await import(root+'forge-billable-usage.ts')
const cases=[]
const saveCase=(kind,input,fn)=>{
 try{cases.push({kind,input,valid:true,output:fn()})}
 catch{cases.push({kind,input,valid:false})}
}
const d=v=>new Date(v), iso=v=>v.toISOString()
const dateFields=(value,fields)=>Object.fromEntries(Object.entries(value).map(([key,v])=>[key,fields.includes(key)&&v!==null?d(v):v]))
const state=v=>v===null?null:dateFields(v,['terminatedAt','unsupportedPauseAt','paidActivatedAt','paymentFailedAt','graceExpiresAt','currentPeriodStart','currentPeriodEnd','cancellationPeriodEnd'])
const actor={userId:'user',workspaceId:'workspace',workspaceRole:'owner',authentication:{kind:'session',sessionId:'session'},scopes:null}
const schemas={selfServePlan:plans.selfServePlanSchema,standardPlan:plans.standardPlanSchema,billingPlan:plans.billingPlanSchema,phase:plans.workspaceAccessPhaseSchema,currency:plans.billingCurrencySchema,members:plans.billableMemberCountSchema}
for(const [schema,parser] of Object.entries(schemas))for(const value of [null,true,0,1,1.5,-1,5,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,'','free','starter','plus','enterprise','basic','business','standard','trial','eur','usd','EUR'])saveCase('schema',{schema,value},()=>parser.parse(value))
for(const plan of ['free','starter','plus','enterprise','basic'])for(const currentMembers of [0,4,5,6,-1,1.5,Number.MAX_SAFE_INTEGER])for(const additionalMembers of [1,2,0,-1,1.5,Number.MAX_SAFE_INTEGER])saveCase('capacity',{plan,currentMembers,additionalMembers},()=>plans.workspaceMemberCapacity(plan,currentMembers,additionalMembers))
for(const plan of ['free','starter','plus','enterprise','bad'])for(const sizeBytes of [0,1,10000000,10000001,1.5,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1])saveCase('upload',{plan,sizeBytes},()=>plans.newUploadPlanAdmission(plan,sizeBytes))
for(const plan of ['starter','plus','free','enterprise'])for(const members of [0,1,5,-1,1.5,Math.floor(Number.MAX_SAFE_INTEGER/1600),Number.MAX_SAFE_INTEGER])saveCase('price',{plan,members},()=>plans.monthlyWorkspacePrice(plan,members))
for(const perMemberLimit of [0,1,5000000,-1,1.5,Number.MAX_SAFE_INTEGER])for(const members of [0,1,5,-1,1.5,Number.MAX_SAFE_INTEGER])saveCase('pool',{perMemberLimit,members},()=>plans.pooledWorkspaceLimit(perMemberLimit,members))
const accepted=[]
for(let a=65;a<=90;a++)for(let b=65;b<=90;b++){
 const code=String.fromCharCode(a,b)
 if(countries.billingCountrySchema.safeParse(code).success)accepted.push(code)
 for(const value of [code,` ${code.toLowerCase()} `])saveCase('country',value,()=>countries.workspaceBillingCurrency(value))
}
for(const value of [null,12,{},'', 'FRA','🇫🇷','ſg','ıd'])saveCase('country',value,()=>countries.workspaceBillingCurrency(value))
const env={FORGE_BILLING_ENABLED:'true',POLAR_ENVIRONMENT:'sandbox',POLAR_ACCESS_TOKEN:' fixture-token ',POLAR_WEBHOOK_SECRET:' fixture-secret ',POLAR_STARTER_EUR_PRODUCT_ID:'11111111-1111-4111-8111-111111111111',POLAR_STARTER_USD_PRODUCT_ID:'22222222-2222-4222-8222-222222222222',POLAR_PLUS_EUR_PRODUCT_ID:'33333333-3333-4333-8333-333333333333',POLAR_PLUS_USD_PRODUCT_ID:'44444444-4444-4444-8444-444444444444',BETTER_AUTH_URL:'https://FORGE.example.test:443/'}
for(const value of [{},env,{FORGE_BILLING_ENABLED:'false',BETTER_AUTH_URL:'bad'}])saveCase('configuration',value,()=>readBillingConfig(value))
for(const key of Object.keys(env))for(const replacement of [undefined,'',' ', 'bad']){const value={...env,[key]:replacement};saveCase('configuration',value,()=>readBillingConfig(value))}
for(const environment of ['sandbox','production'])for(const appUrl of ['http://localhost:3000','http://127.0.0.1','http://[::1]:3000/','http://example.test','https://example.test/path','https://private:secret@example.test','https://example.test/?x=1','https://example.test/#x','https://example.test:8443/','https://例え.テスト/','https://example.test/?','https://example.test/#','https://example.test/?#','https://:@example.test/']){const value={...env,POLAR_ENVIRONMENT:environment,BETTER_AUTH_URL:appUrl};saveCase('configuration',value,()=>readBillingConfig(value))}
for(const workspaceRole of ['owner','admin','member','guest',' member, admin ','OWNER',''])for(const kind of ['session','apiKey','agent','loop']){const value={...actor,workspaceRole,authentication:{kind,sessionId:'s',credentialId:'c',runId:'r',tokenId:'t',loopId:'l'}};saveCase('identity',value,()=>workspaceBillingIdentity(value))}
for(const key of ['workspaceId','userId'])for(const replacement of ['',' \n',' padded ']){const value={...actor,[key]:replacement};saveCase('identity',value,()=>workspaceBillingIdentity(value))}
for(const plan of ['free','starter','plus','enterprise'])for(const accessPhase of ['standard','trial'])for(const feature of ['agent','calls','signals','bad'])for(const billingMode of [...model.MODEL_BILLING_MODES,'bad']){
 const input={plan,accessPhase,feature,billingMode};saveCase('charge',input,()=>workspaceUsageChargePolicy(input))
 for(const providerCostMicros of [0,17,-1,1.5,Number.MAX_SAFE_INTEGER+1,null]){const value={...input,providerCostMicros};saveCase('cost',value,()=>forgeBillableCostMicros(value))}
}
for(const boundary of ['2027-01-31T17:42:03.123Z','2028-01-31T17:42:03.123Z','2027-02-28T17:42:03.123Z','2027-12-31T23:59:59.999Z','2000-02-29T00:00:00.000Z','bad'])for(const anchorDay of [0,1,15,28,29,30,31,32,1.5])saveCase('next-month',{boundary,anchorDay},()=>iso(nextAnchoredMonth(d(boundary),anchorDay)))
const anchors=[]
for(const year of [1900,2000,2027,2028,2100])for(const month of [0,1,3,10,11])for(const day of [1,15,28,29,30,31]){
 const start=new Date(Date.UTC(year,month,day,17,42,3,123));if(start.getUTCMonth()!==month)continue
 const end=nextAnchoredMonth(start,day);const pair={start:iso(start),end:iso(end)};anchors.push(pair)
 saveCase('anchor',pair,()=>captureMonthlyBillingAnchor(start,end))
 for(const offset of [-1,1]){const moved=new Date(+end+offset),input={start:iso(start),end:iso(moved)};saveCase('anchor',input,()=>captureMonthlyBillingAnchor(start,moved))}
 const schedule={originalPeriodStart:iso(start),effectiveAt:iso(end),anchorDay:day,nextRenewalAt:iso(nextAnchoredMonth(end,day)),checkoutGraceEndsAt:iso(new Date(+end+7*86400000)),paidAt:iso(new Date(+end+3*86400000))}
 for(const paidAt of [iso(new Date(+end-1)),iso(end),schedule.paidAt,schedule.checkoutGraceEndsAt]){const value={...schedule,paidAt};saveCase('replacement',value,()=>replacementAnniversarySchedule(dateFields(value,['originalPeriodStart','effectiveAt','nextRenewalAt','checkoutGraceEndsAt','paidAt'])))}
}
const workspaceId='workspace',created='2027-01-31T17:42:03.123Z',trialStart='2027-02-01T10:00:00.000Z',trialEnd='2027-02-15T10:00:00.000Z',paidStart='2027-02-28T17:42:03.123Z',paidEnd='2027-03-31T17:42:03.123Z'
for(const source of [{kind:'free',workspaceCreatedAt:created},{kind:'trial',trialStartedAt:trialStart},{kind:'paid-monthly',currentPeriodStart:paidStart,currentPeriodEnd:paidEnd}])for(const now of ['2027-01-31T17:42:03.122Z',created,trialStart,trialEnd,paidStart,paidEnd,'2027-04-30T17:42:03.123Z','2028-02-29T17:42:03.123Z','bad'])for(const workspace of ['workspace',' ', ' padded ']){const input={workspaceId:workspace,now,source};saveCase('period',input,()=>workspaceUsagePeriod(workspace,d(now),dateFields(source,['workspaceCreatedAt','trialStartedAt','currentPeriodStart','currentPeriodEnd'])))}
const redemptionId='55555555-5555-4555-8555-555555555555'
for(const now of ['2027-02-15T09:59:59.999Z',trialEnd,paidStart,paidEnd])for(const settled of [0,5,5000000,Number.MAX_SAFE_INTEGER])for(const reserved of [0,1,2000000,-1]){
 const input={workspaceId,redemptionId,workspaceCreatedAt:created,trialStartedAt:trialStart,now,settledTrialMicros:settled,reservedTrialMicros:reserved};saveCase('trial-carryover',input,()=>trialExpiryCarryover(dateFields(input,['workspaceCreatedAt','trialStartedAt','now'])))
 const paid={workspaceId,sourcePeriodId:redemptionId,workspaceCreatedAt:created,paidAccessEndedAt:trialEnd,now,settledPoolUsdMicros:settled,reservedPoolUsdMicros:reserved};saveCase('paid-carryover',paid,()=>paidToFreeCarryover(dateFields(paid,['workspaceCreatedAt','paidAccessEndedAt','now'])))
}
const trial={plan:'business',status:'trialing',source:'forge-trial',sourceReference:redemptionId,trialRedemptionId:redemptionId,currentPeriodStart:trialStart,currentPeriodEnd:trialEnd}
const paid={plan:'business',status:'active',source:'polar',sourceReference:'sub',providerEnvironment:'sandbox',paidActivatedAt:'2027-02-01T10:00:00.000Z',currentPeriodStart:paidStart,currentPeriodEnd:paidEnd}
const grace={...paid,status:'past_due',paymentFailedAt:paidEnd,graceExpiresAt:'2027-04-07T17:42:03.123Z'}
const states=[null,trial,paid,grace,{plan:'enterprise',status:'active',source:'internal'}, {plan:'basic',status:'active',source:'internal'}, {...paid,cancelAtPeriodEnd:true,cancellationPeriodEnd:'2027-03-15T00:00:00.000Z'}, {...paid,unsupportedPauseAt:'2027-03-15T00:00:00.000Z'}, {...paid,terminatedAt:'2027-03-10T00:00:00.000Z'}, {...paid,refundedPeriods:[{orderId:'o',subscriptionId:'sub',environment:'sandbox',start:paidStart,end:paidEnd,refundedAt:'2027-03-05T00:00:00.000Z'}]}, {...trial,trialRedemptionId:null},{...paid,providerEnvironment:'wrong'},{...paid,currentPeriodStart:'2026-01-01T00:00:00.000Z'}, {plan:'free',status:'canceled',source:'unknown'}]
for(const snapshot of states)for(const now of ['2027-01-01T00:00:00.000Z',created,trialStart,trialEnd,paidStart,'2027-03-14T00:00:00.000Z','2027-03-16T00:00:00.000Z',paidEnd,'2027-04-07T17:42:03.123Z','2027-05-01T00:00:00.000Z','bad']){
 const input={workspaceId,workspaceCreatedAt:created,state:snapshot,now};saveCase('authority',input,()=>resolveWorkspaceUsageAuthority({...input,state:state(snapshot),workspaceCreatedAt:d(created),now:d(now)}))
 for(const activeMembers of [0,4,5,12])saveCase('notices',{state:snapshot,now,activeMembers},()=>workspaceBillingNotices(state(snapshot),activeMembers,d(now)))
}
for(const snapshot of states.filter(Boolean))saveCase('paid-binding',snapshot,()=>paidUsageBinding(state(snapshot)))
const noticeMessages={}
for(const c of cases.filter(c=>c.kind==='notices'&&c.valid))for(const n of c.output){const key=n.code==='free-capacity'?`${n.code}-${c.input.activeMembers>=5?'high':'low'}`:n.code;noticeMessages[key]=n.message}
function save(file,value){const path=new URL(file,import.meta.url),text=JSON.stringify(value,null,2)+'\n';if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==text)throw Error(`${file} is stale`)}else writeFileSync(path,text)}
save('../rust/crates/forge-core/data/billing-policy.json',{countries:accepted,euroCountries:countries.euroBillingCountries,limits:plans.planResourceLimits,monthlySeatPriceMinor:plans.monthlySeatPriceMinor,noticeMessages})
save('../rust/crates/forge-core/data/billing-reference.json',{cases})
console.log(`Billing reference: ${cases.length} cases, ${accepted.length} country codes`)
