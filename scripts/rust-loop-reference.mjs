import {legacyIntlTimezones} from './rust-intl-timezones.mjs'
import { readFileSync, writeFileSync } from 'node:fs'
import * as c from '../apps/forge/src/lib/loop-contract.ts'
import * as m from '../apps/forge/src/lib/loop-matching.ts'
import { resolveLoopModel } from '../apps/forge/src/application/loops/loop-model-routing.ts'
import { loopSchedulerDriver } from '../apps/forge/src/application/loops/loop-execution-policy.ts'

const id = '00000000-0000-4000-8000-000000000001'
const leaf = {field:'priority',operator:'is',values:['high']}
const fields = {name:'Investigate',description:'',instructions:'Investigate this event.',trigger:{kind:'event',entity:'issue',event:'created'},conditions:[],reasoning:'auto',teamAccess:'this-team'}
const schedule = {kind:'schedule',unit:'days',interval:1,startAt:'2026-03-28T08:00:00.000Z',timeZone:'Europe/Paris'}
const cases=[]
const schemas={leaf:c.loopLeafConditionSchema,condition:c.loopConditionSchema,trigger:c.loopTriggerSchema,fields:c.loopFieldsSchema,command:c.loopCommandSchema}
function add(kind,input){const r=schemas[kind].safeParse(input);cases.push({kind,input,valid:r.success,...(r.success?{output:r.data}:{})})}
for(const kind of Object.keys(schemas))for(const input of [null,[],{},false,''])add(kind,input)
for(const field of [...c.LOOP_FIELDS,'__proto__.admin','unknown'])for(const operator of ['is','isNot','any','none','contains','and'])add('leaf',{...leaf,field,operator})
for(const values of [[],[''],[' '],['\ufeff'],['A','B'],['🙂'.repeat(1000)],['🙂'.repeat(1001)],Array(50).fill('x'),Array(51).fill('x'),[null],[1]])for(const operator of ['is','contains'])add('leaf',{...leaf,operator,values})
add('leaf',{...leaf,unknown:true})
let group=leaf
for(let depth=0;depth<=6;depth++){add('condition',group);add('fields',{...fields,conditions:[group]});group={operator:'and',conditions:[group]}}
for(const conditions of [[],[leaf],Array(8).fill(leaf),Array(9).fill(leaf)]){
 add('condition',{operator:'or',conditions});add('fields',{...fields,conditions});add('fields',{...fields,conditions:[{operator:'and',conditions},leaf]})
}
const triggers=[]
for(const entity of c.LOOP_ENTITIES)for(const event of c.LOOP_EVENT_NAMES){
 for(const property of [undefined,...c.LOOP_FIELDS]){
  const t={kind:'event',entity,event,...(property?{property}:{})};add('trigger',t)
  if(c.loopTriggerSchema.safeParse(t).success)triggers.push(t)
 }
 for(const values of [[],[''],['__none__'],Array(51).fill('x')])add('trigger',{kind:'event',entity,event,values})
}
for(const commentMode of [undefined,'any','newThread','contains','mentions','bad'])for(const commentText of [undefined,'',' A.*BUG '])for(const mentionIds of [undefined,[],['member']])for(const event of ['created','comment'])add('trigger',{kind:'event',entity:'issue',event,...(commentMode===undefined?{}:{commentMode}),...(commentText===undefined?{}:{commentText}),...(mentionIds===undefined?{}:{mentionIds})})
for(const [key,values] of Object.entries({unit:['hours','weeks','months','years','minute'],interval:[0,1,1000,1001,1.5,null],startAt:['2026-01-01T12:34Z','2026-01-01T12:34:56.1234567891Z','2026-01-01T12:34:56+01:00','2026-01-01T24:00:00Z','2026-02-29T12:00Z','2028-02-29T12:00Z','0000-01-01T00:00Z','9999-12-31T23:59Z','2026-01-01t12:34:56z','2026-01-01T12:34:60Z','2026-01-01T12:34:56Z\n'],timeZone:['UTC','utc','europe/paris','US/Eastern','Asia/Calcutta','CST','Etc/GMT+12','+01:30','+0130','+01','-23:59','+24:00','UTC+01','Europe/Paris ','Mars/Olympus',''],weekdays:[[],[1],[7,1],[1,1],[0],[8],null],unknown:[true]}))for(const value of values)add('trigger',{...schedule,[key]:value})
for(const weekdays of [undefined,[],[1],[7,1],[1,1],[0],[8],null,Array(8).fill(1)])add('trigger',{...schedule,unit:'weeks',...(weekdays===undefined?{}:{weekdays})})
for(const startAt of ['0000-01-01T00:00:00Z','2028-02-29T12:00:00Z','9999-12-31T23:59:00Z'])add('trigger',{...schedule,startAt})
for(const timeZone of legacyIntlTimezones)for(const value of [timeZone,timeZone.toLowerCase()])add('trigger',{...schedule,timeZone:value})
add('trigger',{kind:'webhook'});add('trigger',{kind:'webhook',enabled:true})
for(const entity of c.LOOP_ENTITIES)for(const field of c.LOOP_FIELDS)add('fields',{...fields,trigger:{kind:'event',entity,event:'created'},conditions:[{...leaf,field}]})
for(const [key,values] of Object.entries({name:['',' \ufeff ',' hello\u00a0','🙂'.repeat(64),'🙂'.repeat(65)],description:[' x ','x'.repeat(255),'x'.repeat(256),null],instructions:['','x'.repeat(20000),'x'.repeat(20001)],reasoning:['low','medium','high','xhigh',null],teamAccess:['all-public-teams','workspace',null],trigger:[schedule,{kind:'webhook'}],enabled:[true]}))for(const value of values)add('fields',{...fields,[key]:value})
for(const trigger of [schedule,{kind:'webhook'}])add('fields',{...fields,trigger,conditions:[leaf]})
for(const action of ['create','save','delete','enable','disable','rotate-webhook','approve','deny','cancel-run','run-now']){
 const command={action,id,...(action==='create'?{}:{expectedRevision:0}),...(['create','save'].includes(action)?{fields}:{}),...(['approve','deny','cancel-run'].includes(action)?{runId:id}:{}),...(['approve','deny'].includes(action)?{approvalId:id,inputHash:'a'.repeat(64)}:{})}
 add('command',command);add('command',{...command,enabled:true});add('command',{...command,id:'wrong'})
 for(const key of Object.keys(command)){const input={...command};delete input[key];add('command',input)}
 if(action!=='create')for(const expectedRevision of [-1,1.5,9007199254740991,9007199254740992,null])add('command',{...command,expectedRevision})
 if(action==='run-now')for(const entityId of [id,null,'wrong'])add('command',{...command,entityId})
 if(action==='approve')for(const inputHash of ['A'.repeat(64),'a'.repeat(64)+'\n','a'.repeat(63)])add('command',{...command,inputHash})
}

const conditions=[]
function condition(input,entity){conditions.push({input,entity,output:m.matchesLoopConditions(input,entity)})}
for(const operator of ['is','isNot','any','none','contains'])for(const selected of [['__none__'],['high'],['false'],['0'],['1e+21'],['A.*BUG'],['ΟΣ'],['İ'],['high','__none__']]){
 if(operator==='contains'&&selected.length!==1)continue
 for(const value of [undefined,null,'',[],[''],['high'],['high','low'],'high',true,false,0,1e21,1e-7,'An a.*bug report','ΟΣ','İ'])condition([{field:'priority',operator,values:selected}],value===undefined?{}:{priority:value})
}
for(const entity of [{},{priority:'low',labels:['bug'],status:'todo'},{priority:'high',labels:[],status:'done'},{priority:'low',labels:['bug'],status:'done'}])condition([{operator:'or',conditions:[leaf,{operator:'and',conditions:[{field:'labels',operator:'any',values:['bug']},{field:'status',operator:'is',values:['todo']}]}]}],entity)
const events=[]
function event(trigger,event,conditions=[]){const input={trigger,conditions};events.push({input,event,output:m.matchesLoopEvent(input,event)})}
for(const trigger of triggers)for(const actual of ['created','updated','comment','update','started','completed'])for(const entity of [trigger.entity,trigger.entity==='issue'?'project':'issue'])event(trigger,{entity,event:actual,before:{status:'todo',labels:['bug'],members:['old'],triage:false},after:{status:'done',labels:['new'],members:['new'],triage:true}})
for(const ev of ['changed','added','removed'])for(const values of [undefined,[],['bug'],['__none__'],['__none__','bug']])for(const [before,after] of [[null,null],['bug',null],[[],[]],[['bug'],[]],[[],['bug']],[['bug','new'],['new','bug']],[['__none__'],[]],[['bug'],['bug']]])event({kind:'event',entity:'issue',event:ev,property:'labels',...(values===undefined?{}:{values})},{entity:'issue',event:'updated',before:{labels:before},after:{labels:after}})
for(const commentMode of [undefined,'any','newThread','contains','mentions'])for(const comment of [undefined,{text:''},{text:'Please A.*BUG @Alice',parentId:'parent',mentionIds:[]},{text:'Please A.*BUG',parentId:'',mentionIds:['alice']},{text:'Please arbitrary bug',parentId:null,mentionIds:['alice']}])for(const name of ['comment','updated'])event({kind:'event',entity:'issue',event:'comment',...(commentMode?{commentMode}:{}),...(commentMode==='contains'?{commentText:'a.*bug'}:{}),...(commentMode==='mentions'?{mentionIds:['alice']}:{})},{entity:'issue',event:name,before:{},after:{},...(comment?{comment}:{})})
for(const before of [null,{triage:false,priority:'high'},{triage:true,priority:'low'},{triage:true,priority:'high'}])for(const after of [{triage:false,priority:'high'},{triage:true,priority:'low'},{triage:true,priority:'high'}])for(const name of ['created','updated','comment'])event({kind:'event',entity:'issue',event:'triage'},{entity:'issue',event:name,before,after},[leaf])
event({kind:'webhook'},{entity:'issue',event:'created',before:null,after:{}})

const schedules=[]
function next(input,after){try{const output=m.nextLoopScheduledAt(input,new Date(after)).toISOString();schedules.push({input,after,valid:true,output})}catch(error){schedules.push({input,after,valid:false,message:error.message})}}
for(const timeZone of ['UTC','Europe/Paris','America/New_York','Australia/Lord_Howe','Pacific/Apia','Asia/Kathmandu','+05:45','europe/paris','CST'])for(const unit of ['hours','days','weeks','months','years'])for(const interval of [1,2,1000]){
 const input={...schedule,timeZone,unit,interval,...(unit==='weeks'?{weekdays:[7,1,5]}:{})}
 for(const after of ['2026-01-01T00:00:00Z',input.startAt,'2026-11-03T13:28:27.123Z'])next(input,after)
}
for(const startAt of ['2026-03-28T01:30:00Z','2026-10-24T00:30:00Z','2026-01-31T08:00:00.987Z','2024-02-29T08:00:00Z','2026-03-28T08:00Z','2026-03-28T08:00:00.1234567891Z'])for(const unit of ['hours','days','weeks','months','years']){
 const input={...schedule,unit,startAt,...(unit==='weeks'?{weekdays:[6,1,5]}:{})};let after=startAt
 for(let i=0;i<4;i++){next(input,after);after=schedules.at(-1).output}
}
for(const [timeZone,startAt] of [['Australia/Lord_Howe','2026-10-03T15:15:00Z'],['Pacific/Apia','2011-12-29T20:00:00Z'],['America/New_York','2026-10-31T05:30:00Z'],['UTC','0000-01-01T00:00:00Z'],['UTC','0099-01-01T00:00:00Z']])next({...schedule,timeZone,startAt},startAt)
for(const timeZone of ['Europe/Paris','America/New_York','Australia/Lord_Howe','Pacific/Apia','Asia/Kathmandu','UTC'])for(const unit of ['days','months','years'])next({...schedule,timeZone,unit,interval:1000,startAt:'9999-12-30T08:00:00Z'},'9999-12-30T08:00:00Z')
for(const timeZone of legacyIntlTimezones)next({...schedule,timeZone},'2026-11-03T13:28:27.123Z')
const local=[]
for(const zone of ['UTC','Europe/Paris','America/New_York','Australia/Lord_Howe','Pacific/Apia','+05:45','europe/paris'])for(const input of ['2026-03-29T02:30','2026-10-25T02:30','2026-11-01T01:30','2026-03-08T02:30','2011-12-30T10:00','2026-10-04T02:15','2028-02-29T12:00','2026-02-29T12:00','0999-01-01T00:00','1000-01-01T00:00','9999-12-31T23:59','2026-01-01T24:00','2026-01-01T12:60','2026-1-01T12:00','2026-01-01T12:00\n']){
 try{const output=m.loopScheduleStart(input,zone);local.push({input,zone,valid:true,output,outputMs:+new Date(output),display:m.loopLocalDateTime(new Date(output),zone)})}catch(error){local.push({input,zone,valid:false,message:error.message})}
}
const model={selectionId:`${id}:gpt-6-luna`,connectionId:id,executionKind:'forge-native',provider:'openai',modelId:'gpt-6-luna',displayName:'Cloud model',providerLabel:'OpenAI',sourceLabel:'Workspace API',locality:'server-capable',billingMode:'pay-as-you-go',inputModalities:['text'],supportsTools:true,supportsCode:true,supportedReasoningEfforts:['low','medium','high'],contextWindowTokens:null,status:'available'}
const routes=[]
for(const candidate of [model,{...model,provider:'anthropic'},{...model,locality:'local-only'},{...model,executionKind:'external-agent'},{...model,supportsTools:false},{...model,supportedReasoningEfforts:[]},{...model,supportedReasoningEfforts:['low']}])for(const reasoningEffort of [undefined,'low','medium','high','xhigh']){
 const input={mode:'auto',message:'Summarize one event',availableModels:[candidate],...(reasoningEffort===undefined?{}:{reasoningEffort})}
 try{routes.push({input,valid:true,output:await resolveLoopModel(input)})}catch(error){routes.push({input,valid:false,code:error.code,message:error.message})}
}
const drivers=[{},...['vercel','cloudflare','','native','Vercel'].map(FORGE_LOOP_SCHEDULER_DRIVER=>({FORGE_LOOP_SCHEDULER_DRIVER}))].map(input=>{try{return{input,valid:true,output:loopSchedulerDriver(input)}}catch(error){return{input,valid:false,message:error.message}}})
const labels=[...triggers,schedule,{kind:'webhook'}].map(input=>({input,output:c.loopTriggerLabel(input)}))
const fixture={cases,conditions,events,schedules,local,routes,drivers,labels}
const path=new URL('../rust/crates/forge-core/data/loops-reference.json',import.meta.url)
const output=JSON.stringify(fixture,null,2)+'\n'
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error('Loop reference changed')}else writeFileSync(path,output)
console.log('Loop reference: '+Object.entries(fixture).map(([key,value])=>`${value.length} ${key}`).join(', '))
