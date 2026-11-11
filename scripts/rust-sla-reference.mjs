import {createHash} from 'node:crypto'
import {slaDurationSchema,sharedSlaRuleSchema,sharedSlaPolicySchema,slaPolicyCommandSchema,slaReadSchema,slaReconciliationSchema} from '../apps/forge/src/lib/shared-sla-contract.ts'
const uuid='00000000-0000-4000-8000-000000000001'
const rule={id:uuid,enabled:true,action:'apply',filters:{priorities:['Urgent']},duration:{unit:'hour',value:1},startMode:'ruleMatch'}
const policy={enabled:true,workWeek:'mon-fri',rules:[rule]}
const identity={workspaceId:'workspace',sessionId:'session'}
const bases={duration:rule.duration,rule,policy,command:{...identity,commandKey:uuid,expectedRevision:0,values:policy},read:identity,reconciliation:{...identity,commandKey:uuid,commitmentId:uuid,expectedVersion:'a'.repeat(64),decision:'breach-owed',evidence:' Reviewed the unavailable interval. '}}
const schemas={duration:slaDurationSchema,rule:sharedSlaRuleSchema,policy:sharedSlaPolicySchema,command:slaPolicyCommandSchema,read:slaReadSchema,reconciliation:slaReconciliationSchema}
export const sla={cases:[],gates:[],versions:[]}
function record(kind,input){const r=schemas[kind].safeParse(input);sla.cases.push({kind,input,valid:r.success,value:r.success?r.data:null})}
for(const [kind,base] of Object.entries(bases)){
 for(const input of [base,null,[],{},true,1,{...base,unknown:true}])record(kind,input)
 for(const key of Object.keys(base)){const missing={...base};delete missing[key];record(kind,missing);for(const value of [null,false,'',[],{},-1,0,1])record(kind,{...base,[key]:value})}
}
for(const unit of ['hour','day','business-day','week','month'])for(const value of [0,1,52,53,365,366,8760,8761,1.5])record('duration',{unit,value})
for(const filters of [{},{teamIds:[]},{teamIds:[uuid]},{priorities:['High','High']},{statuses:[{teamId:uuid,statusId:'todo'}]},{statuses:[{teamId:uuid,statusId:'😀'.repeat(255)}]},{statuses:[{teamId:uuid,statusId:'x'.repeat(256)}]},{statuses:[{teamId:uuid,statusId:'todo',extra:1}]},{priorities:['Urgent'],statuses:null}])record('rule',{...rule,filters})
record('rule',{id:uuid,enabled:true,action:'remove',filters:{priorities:['Low']}})
record('policy',{...policy,rules:[rule,rule]})
record('policy',{...policy,rules:[]})
for(const evidence of [' 123456789 ',' 1234567890 ','x'.repeat(500),'x'.repeat(501),'😀'.repeat(500)])record('reconciliation',{...bases.reconciliation,evidence})
for(const expectedVersion of ['a'.repeat(64)+'\n','A'.repeat(64),'a'.repeat(63)])record('reconciliation',{...bases.reconciliation,expectedVersion})
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
for(const deployment of ['deployment-fixture','local:public-process-fixture'])for(const workspaceId of ['workspace','space 😀'])for(const enabled of [false,true])sla.gates.push({deployment,workspaceId,enabled,hash:hash({deployment,workspaceId,enabled})})
for(const classified of [null,'2026-11-10 02:03:04.123456+00'])for(const owed of [null,'2026-11-10 01:02:03.123456+00'])sla.versions.push({id:uuid,gate:'old-fixture',classified,owed,current:'new-fixture',hash:hash([uuid,'old-fixture',classified,owed,'new-fixture'])})
