// Execute the actual billing arithmetic with fixed dates and synthetic quotes.
// No database, provider requests, environment credentials or wall-clock reads.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import * as model from '../apps/forge/src/application/agents/model-contract.ts'
mock.module('@/application/agents/model-contract',()=>model)
const root='../apps/forge/src/application/billing/'
const money=await import(root+'workspace-overage-money.ts')
const budget=await import(root+'workspace-ai-budget.ts')
const {planMonthlyOverageReport}=await import(root+'overage-invoice-contract.ts')
const {planOverageCurrencyCutover}=await import(root+'overage-currency-cutover.ts')
const {singlePolarUsageAcknowledgement}=await import(root+'polar-usage-event-contract.ts')
const cases=[]
const save=(kind,input,fn)=>{try{cases.push({kind,input,valid:true,output:fn()})}catch{cases.push({kind,input,valid:false})}}
const at='2026-10-29T00:00:00.000Z', max=Number.MAX_SAFE_INTEGER
const rate={id:'a'.repeat(64),source:'ecb-daily-reference',sourceUrl:money.ECB_REFERENCE_URL,referenceDate:'2026-10-28',observedAt:'2026-10-28T16:30:00Z',usdPerEur:'1.2500'}
const dateFields=(v,fields)=>Object.fromEntries(Object.entries(v).map(([k,n])=>[k,fields.includes(k)?new Date(n):n]))
const invoke=(kind,v)=>{
 switch(kind){
  case 'money-capacity':return money.convertBillingCapacity(dateFields(v,['at']))
  case 'money-cost':return money.convertOverageCost(dateFields(v,['incurredAt']))
  case 'money-reserve':return money.reserveWorkspaceOverage(dateFields(v,['incurredAt']))
  case 'money-cutover':return planOverageCurrencyCutover(dateFields(v,['periodStart','periodEnd','cutoverAt']))
  case 'money-invoice':return planMonthlyOverageReport(v)
  case 'ai-allowance':return budget.workspaceAiAllowanceMicros(v.plan,v.activeMembers,v.accessPhase)
  case 'overage-policy':return budget.workspaceOveragePolicySchema.parse(v)
  case 'budget-admission':return budget.evaluateWorkspaceBudgetAdmission(dateFields(v,['incurredAt']))
  case 'polar-usage-ack':return singlePolarUsageAcknowledgement(v)
 }
 throw Error('Unknown fixture operation')
}
const add=(kind,v)=>save(kind,v,()=>invoke(kind,v))
const quotes=[undefined,null,...['1','2','3','1.1','1.2500','1.08765432','0.00000001','99999999.99999999','0','0.00000000','-1','01','1e3','1.000000001','100000000','1.','.1','NaN',''].map(usdPerEur=>({...rate,usdPerEur}))]
for(const currency of ['usd','eur'])for(const providerUsdMicros of [0,1,2,3,4999,5000,9999,14999,5000000,max])for(const rounding of ['reservation','settlement'])for(const rate of quotes)add('money-cost',{currency,providerUsdMicros,incurredAt:at,rounding,rate})
for(const fromCurrency of ['usd','eur'])for(const targetCurrency of ['usd','eur'])for(const amountMicros of [0,1,10,1000000,max])for(const rounding of ['down','up'])for(const rate of [undefined,quotes[4],quotes[5],quotes[9],quotes[10]])add('money-capacity',{fromCurrency,targetCurrency,amountMicros,rounding,at,rate})
const baseCost={currency:'eur',providerUsdMicros:1,incurredAt:at,rounding:'settlement',rate}
for(const [key,replacements] of Object.entries({currency:['EUR','',null],providerUsdMicros:[-1,0.5,max+1,'1',null],incurredAt:['bad','2026-11-04T00:00:00.000Z','2026-11-04T00:00:00.001Z','2026-10-28T16:29:59.999Z','2026-10-28T16:30:00.000Z'],rounding:['up','down',null]}))for(const r of replacements)add('money-cost',{...baseCost,[key]:r})
for(const [key,replacements] of Object.entries({id:['a'.repeat(63),'A'.repeat(64),'g'.repeat(64),null],source:['custom',null],sourceUrl:['https://example.test/rate',null],referenceDate:['2026-10-01','2026-10-29','2026-02-29','2026-2-28','bad'],observedAt:['2026-10-29T00:00:00.001Z','2026-10-28T00:00:00Z','2026-10-27T23:59:59Z','2026-10-28T16:30+02:00','2026-10-28T16:30:00.123456Z','2026-10-28T16:30:00+02:00','2026-10-28T16:30:00','bad'] } ))for(const r of replacements)add('money-cost',{...baseCost,rate:{...rate,[key]:r}})
add('money-cost',{...baseCost,rate:{...rate,unexpected:true}})
for(const key of Object.keys(rate)){const quote={...rate};delete quote[key];add('money-cost',{...baseCost,rate:quote})}
const capacity={fromCurrency:'usd',targetCurrency:'eur',amountMicros:1,at,rate,rounding:'up'}
for(const [key,replacements] of Object.entries({fromCurrency:['bad',null],targetCurrency:['bad',null],amountMicros:[-1,0.5,max+1,null],at:['bad'],rounding:['reservation','settlement',null]}))for(const r of replacements)add('money-capacity',{...capacity,[key]:r})
const reservation={currency:'eur',capMicros:10,settledMicros:5,reservedMicros:1,requestedUsdMicros:5,incurredAt:at,rate}
for(const currency of ['usd','eur'])for(const capMicros of [0,5,10,11,max])for(const settledMicros of [0,5,10,max])for(const requestedUsdMicros of [0,1,5,6])add('money-reserve',{...reservation,currency,capMicros,settledMicros,requestedUsdMicros})
for(const key of ['capMicros','settledMicros','reservedMicros','requestedUsdMicros'])for(const n of [-1,0.5,max+1,null])add('money-reserve',{...reservation,[key]:n})
for(const plan of ['free','starter','plus','enterprise'])for(const accessPhase of ['standard','trial','bad'])for(const activeMembers of [0,1,3,max,-1,0.5])add('ai-allowance',{plan,accessPhase,activeMembers})
const policies=[{enabled:false},{enabled:true,currency:'usd',monthlyCapMicros:0},{enabled:true,currency:'usd',monthlyCapMicros:2000000},{enabled:true,currency:'eur',monthlyCapMicros:2000000},null,{},false,{enabled:'true'},{enabled:false,currency:'usd'},{enabled:true},{enabled:true,currency:'USD',monthlyCapMicros:1},{enabled:true,currency:'usd',monthlyCapMicros:-1},{enabled:true,currency:'usd',monthlyCapMicros:0.5},{enabled:true,currency:'usd',monthlyCapMicros:max+1},{enabled:true,currency:'usd',monthlyCapMicros:1,extra:true}]
for(const policy of policies)add('overage-policy',policy)
const baseBudget={plan:'starter',accessPhase:'standard',feature:'agent',billingMode:'forge-managed',activeMembers:1,billingCurrency:'eur',settledCostMicros:4000000,reservedCostMicros:0,requestedReservationMicros:3000000,settledOverageMicros:0,reservedOverageMicros:0,incurredAt:at,rate,overage:policies[3],paidOverageAuthorized:true}
for(const plan of ['free','starter','plus'])for(const accessPhase of ['standard','trial'])for(const feature of ['agent','calls','signals'])for(const billingMode of model.MODEL_BILLING_MODES)for(const billingCurrency of ['usd','eur'])for(const paidOverageAuthorized of [false,true])for(const settledCostMicros of [0,4999999,5000000,6000000])add('budget-admission',{...baseBudget,plan,accessPhase,feature,billingMode,billingCurrency,paidOverageAuthorized,settledCostMicros,overage:{enabled:true,currency:billingCurrency,monthlyCapMicros:2000000}})
for(const overage of policies)for(const paidOverageAuthorized of [false,true])add('budget-admission',{...baseBudget,overage,paidOverageAuthorized})
for(const key of ['activeMembers','settledCostMicros','reservedCostMicros','requestedReservationMicros','settledOverageMicros','reservedOverageMicros'])for(const n of [-1,0,0.5,max,max+1,null,'1'])add('budget-admission',{...baseBudget,[key]:n})
for(const patch of [{plan:'bad'},{accessPhase:'bad'},{feature:'bad'},{billingMode:'bad'},{billingCurrency:'bad'},{paidOverageAuthorized:'true'},{paidOverageAuthorized:null},{incurredAt:'bad'},{requestedReservationMicros:0,settledCostMicros:5000000,overage:{enabled:false}},{rate:undefined},{rate:undefined,requestedReservationMicros:1000000},{rate:undefined,feature:'calls'},{rate:undefined,billingMode:'pay-as-you-go'},{settledOverageMicros:2000000},{settledCostMicros:max,reservedCostMicros:1},{overage:{enabled:true,currency:'usd',monthlyCapMicros:max},billingCurrency:'usd'}])add('budget-admission',{...baseBudget,...patch})
const cutover={fromCurrency:'usd',targetCurrency:'eur',policy:policies[2],settledMicros:1,reservedMicros:1,periodStart:'2026-10-25T00:00:00Z',periodEnd:'2026-11-25T00:00:00Z',cutoverAt:at,rate}
for(const fromCurrency of ['usd','eur'])for(const targetCurrency of ['usd','eur'])for(const policy of [{enabled:false},{enabled:true,currency:fromCurrency,monthlyCapMicros:0},{enabled:true,currency:fromCurrency,monthlyCapMicros:10}])for(const settledMicros of [0,1,10,max])for(const rate of [undefined,{...cutover.rate,usdPerEur:'3'}])add('money-cutover',{...cutover,fromCurrency,targetCurrency,policy,settledMicros,rate})
for(const patch of [{cutoverAt:'2026-10-24T23:59:59.999Z'},{cutoverAt:cutover.periodStart},{cutoverAt:cutover.periodEnd},{cutoverAt:'bad'},{periodStart:'bad'},{periodEnd:'bad'},{periodStart:cutover.periodEnd},{policy:policies[3]},{policy:{enabled:false,extra:true}},{reservedMicros:-1},{reservedMicros:max,settledMicros:1,targetCurrency:'usd'},{rate:{...rate,usdPerEur:'0.00000001'},settledMicros:max}])add('money-cutover',{...cutover,...patch})
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const converted=(n,currency='usd',usdPerEur='3')=>money.convertOverageCost({currency,providerUsdMicros:n,incurredAt:new Date(at),rate:{...rate,usdPerEur},rounding:'settlement'})
for(const currency of ['usd','eur'])for(const amounts of [[],[1],[4999],[5000],[9999],[14999],[1001,1001,1001,1001,1001],[105000],[max]])for(const previouslyReportedMinor of [0,1,10,11,100,max])add('money-invoice',{currency,previouslyReportedMinor,usage:amounts.map((n,i)=>({usageId:uid(i),money:converted(n,currency)}))})
const row={usageId:uid(1),money:converted(1000)}
for(const patch of [{amountMicros:1},{amountMicros:'1000'},{exactNumerator:'1'},{exactNumerator:'01000'},{exactNumerator:1000},{exactDenominator:'2'},{exactDenominator:1},{rounding:'reservation'},{currency:'eur'},{providerUsdMicros:-1},{incurredAt:'bad'}])add('money-invoice',{currency:'usd',previouslyReportedMinor:0,usage:[{...row,money:{...row.money,...patch}}]})
for(const usage of [[row,row],[{...row,usageId:'bad'}],[{...row,usageId:'ffffffff-ffff-ffff-ffff-ffffffffffff'}]])add('money-invoice',{currency:'usd',previouslyReportedMinor:0,usage})
for(const previous of [-1,0.5,max+1,null])add('money-invoice',{currency:'usd',previouslyReportedMinor:previous,usage:[]})
// Compact recipes keep boundary fixtures reviewable, while both runners expand
// the complete 10,000/10,001-row input before calling the owning implementation.
for(const count of [10000,10001]){
 const input={currency:'usd',previouslyReportedMinor:0,usage:[row]}
 save('money-invoice',input,()=>invoke('money-invoice',{...input,usage:Array.from({length:count},(_,i)=>({...row,usageId:uid(i)}))}))
 cases.at(-1).repeatUsageCount=count
}
const primes=[]
for(let n=10000019;primes.length<150;n+=2){let prime=true;for(let d=3;d*d<=n;d+=2)if(n%d===0){prime=false;break}if(prime)primes.push(n)}
for(const count of [100,150])add('money-invoice',{currency:'eur',previouslyReportedMinor:0,usage:primes.slice(0,count).map((p,i)=>({usageId:uid(i),money:converted(1,'eur',String(p))}))})
for(const inserted of [0,1,2,-1,0.5,'1',null])for(const duplicates of [undefined,0,1,2,-1,0.5,'1',null])add('polar-usage-ack',{inserted,duplicates,ignored:'provider-metadata'})
for(const v of [null,{},false,[]])add('polar-usage-ack',v)
const path=new URL('../rust/crates/forge-core/data/billing-money-reference.json',import.meta.url)
const output=JSON.stringify({cases},null,2)+'\n'
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error('Billing money reference is stale')}else writeFileSync(path,output)
console.log(`Billing money reference: ${cases.length} source cases`)
