// Evaluate the owning script's conditions against an in-memory relational
// adapter. Its environment loader, telemetry and database imports never run.
import {readFileSync,writeFileSync} from 'node:fs'
const source=readFileSync(new URL('../apps/forge/scripts/check-workflow-health.ts',import.meta.url),'utf8')
const imports=source.match(/^import .* from .*$/gm) ?? []
const environment='validateJobEnvironment("workflow-health")'
const database='await import("@/db")'
const result='if (issues.length > 0) process.exitCode = 1'
if(imports.length!==4 || ![environment,database,result].every(marker=>source.split(marker).length===2))
  throw Error('Workflow health script structure changed; review the reference adapter.')
const extracted=source.replace(/^import .* from .*$/gm,'').replace(environment,'')
  .replace(database,'fixtureDb').replace(result,'return {issues, count:missingSdkRuns.length}')
if(/\bimport\s*[({"']/.test(extracted))throw Error('Unexpected import in isolated health reference')
const code=new Bun.Transpiler({loader:'ts'}).transformSync(extracted)
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor
const evaluate=new AsyncFunction('and','eq','inArray','isNull','lte','emitTelemetry','runMonitoredJob','fixtureDb','Date',code)
const now=new Date('2030-01-01T00:00:00Z')
class FixedDate extends Date {constructor(...args){super(...(args.length?args:[+now]))}static now(){return +now}}
const table=(name,keys)=>Object.assign({_name:name},Object.fromEntries(keys.map(k=>[k,k])))
const runs=table('runs',['id','workspaceId','kind','state','sdkRunId','createdAt','startedAt'])
const effects=table('effects',['businessRunId','effectKey','state','completedAt'])
const ago=ms=>new Date(+now-ms).toISOString()
const baseline={id:'00000000-0000-4000-8000-000000000001',workspaceId:'fixture',kind:'workspace-invitation-lifecycle-v1',state:'running',sdkRunId:'external-sdk-fixture',createdAt:ago(3600000),startedAt:ago(900000),initial:null,reminder:null,job:null}
const cases=[]
for(const state of ['queued','starting'])for(const sdkRunId of [null,'','external-sdk-fixture'])for(const age of [299999,300000,300001])
  cases.push({...baseline,state,sdkRunId,createdAt:ago(age)})
for(const state of ['failed-to-start','failed','cancelled','completed'])for(const sdkRunId of [null,'external-sdk-fixture'])
  cases.push({...baseline,state,sdkRunId})
for(const started of [null,899999,900000,900001])for(const initial of [null,'sending','completed'])
for(const completed of [null,87299999,87300000,87300001])for(const reminder of [null,'sending','completed'])
  cases.push({...baseline,startedAt:started===null?null:ago(started),initial:initial===null?null:{state:initial,completedAt:completed===null?null:ago(completed)},reminder:reminder===null?null:{state:reminder,completedAt:null}})
cases.push({...baseline,kind:'other-workflow'},{...baseline,state:'queued',sdkRunId:'external-sdk-fixture'})
const unique=[...new Map(cases.map(value=>[JSON.stringify(value),value])).values()]
const fixtures=[]
for(const input of unique){
  const row={...input,createdAt:new Date(input.createdAt),startedAt:input.startedAt===null?null:new Date(input.startedAt)}
  const data={runs:[row],effects:[['initial',input.initial],['reminder-24h',input.reminder]].filter(([,v])=>v).map(([effect,value])=>({businessRunId:input.id,effectKey:`workspace-invitation:fixture:${effect}:v1`,state:value.state,completedAt:value.completedAt===null?null:new Date(value.completedAt)}))}
  const db={select:shape=>({from:t=>({where:predicate=>Promise.resolve(data[t._name].filter(predicate).map(row=>Object.fromEntries(Object.entries(shape).map(([name,col])=>[name,row[col]]))))})})}
  let output
  await evaluate((...conditions)=>row=>conditions.every(condition=>condition(row)),(col,value)=>row=>row[col]===value,(col,values)=>row=>values.includes(row[col]),col=>row=>row[col]===null,(col,value)=>row=>row[col]!==null&&row[col]<=value,()=>{},async(_key,run)=>{output=await run()}, {businessWorkflowRuns:runs,businessWorkflowEffects:effects,db},FixedDate)
  fixtures.push({input,now:now.toISOString(),code:output.issues[0]?.code??null,count:output.count})
}
const path=new URL('../rust/crates/forge-core/data/workflow-health-reference.json',import.meta.url)
const output=JSON.stringify(fixtures,null,2)+'\n'
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error('Workflow health reference changed')}else writeFileSync(path,output)
console.log(`Workflow health reference: ${fixtures.length} source cases`)
