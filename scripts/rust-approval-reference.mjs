import {readFileSync} from 'node:fs'
import {createHash,randomUUID} from 'node:crypto'
import {requireAgentRun,requireAgentApproval} from '../apps/forge/src/application/agents/agent-authorization.ts'
import {InMemoryAgentApprovalStore} from '../apps/forge/src/adapters/agents/in-memory-approval-store.ts'
import {InMemoryAgentStore} from '../apps/forge/src/adapters/agents/in-memory-agent-store.ts'
import {InMemoryAgentEventStore} from '../apps/forge/src/adapters/agents/in-memory-event-store.ts'

// Evaluate the owning service with its real in-memory adapters and fixed clock.
// Only the server-only/import boundary is removed; no algorithm is copied here.
const source=readFileSync(new URL('../apps/forge/src/application/agents/approval-service.server.ts',import.meta.url),'utf8')
const js=new Bun.Transpiler({loader:'ts'}).transformSync(source).replace(/^import[\s\S]*?;\s*$/gm,'').replace(/\bexport (?=(?:async )?(?:function|class|const))/g,'')
const {ApprovalService,hashApprovalInput,programGrantAllows}=new Function('createHash','randomUUID','requireAgentRun','requireAgentApproval',js+'\nreturn {ApprovalService,hashApprovalInput,programGrantAllows};')(createHash,randomUUID,requireAgentRun,requireAgentApproval)
export const agentApprovals={hashes:[],grants:[],flows:[]}
const values=[null,true,false,0,-0,1,1e-7,1e21,9007199254740991,'', 'é', '\u0000',[],{},[1,{z:1,a:2}],{z:1,a:2}]
const keys=['z','a','A','ä','é','e\u0301','ß','ss','x_1','x-1','x.1','x 1','2','10','01','0','4294967294','4294967295','🙂','💡','漢字','\u0000','_','__proto__','constructor']
for(const input of [...values.map(value=>({input:value})),...keys.map((_,i)=>Object.fromEntries([...keys.slice(i),...keys.slice(0,i)].map((key,j)=>[key,{z:j,a:values[j%values.length]}]))),{items:values},Object.fromEntries(keys.map(key=>[key,1]))])agentApprovals.hashes.push({input,hash:hashApprovalInput(input)})
for(const capabilityId of ['program.execute','teams.update'])for(const summary of [null,{},[],{details:null},{details:[]},{details:{programManifest:null}},{details:{programManifest:[]}},{details:{programManifest:[null,false,1,'teams.update',{},[],{id:'teams.update',version:'1',maximumCalls:1}]}},{details:{programManifest:[{id:'teams.update',version:1}]}},{details:{programManifest:[{id:'teams.update',version:'2'}]}}])for(const version of ['1','2'])agentApprovals.grants.push({capabilityId,summary,version,allowed:programGrantAllows({capabilityId,redactedInputSummary:summary??{}},'teams.update',version)})
const thread='00000000-0000-4000-8000-000000000001',run='00000000-0000-4000-8000-000000000002',approvalId='00000000-0000-4000-8000-000000000003'
const actor={userId:'fixture-user',workspaceId:'fixture-workspace',workspaceRole:'admin',authentication:{kind:'session',sessionId:'fixture-session'},scopes:null}
const input={slug:'forge',settings:{description:'Updated'}}
const scenarios=[
 [{op:'request'},{op:'find'},{op:'resolve',decision:'approved'},{op:'find'},{op:'consume'},{op:'find'},{op:'consume'},{op:'resolve',decision:'approved'}],
 [{op:'request'},{op:'resolve',decision:'denied'},{op:'consume'},{op:'find'}],
 [{op:'request',expiresAfterMs:0},{op:'resolve',decision:'approved'},{op:'find'},{op:'consume'}],
 [{op:'request'},{op:'resolve',decision:'approved',advance:299999},{op:'consume',advance:1},{op:'resolve',decision:'denied'}],
 [{op:'request'},{op:'request'},{op:'request',changedInput:true},{op:'resolve',decision:'approved'},{op:'consume',changedInput:true},{op:'consume',capability:'teams.delete'},{op:'consume',version:'2'},{op:'consume',wrongRun:true},{op:'consume'}],
 [{op:'request',program:true},{op:'resolve',decision:'approved'},{op:'find'},{op:'consume'},{op:'consume',changedInput:true},{op:'find',capability:'teams.delete'},{op:'consume',capability:'teams.delete'}],
 [{op:'resolve',decision:'approved'},{op:'consume'},{op:'find'}],
 [{op:'request'},{op:'resolve',decision:'approved'},{op:'find',advance:300000},{op:'consume'}],
]
for(const steps of scenarios){
 let now=new Date('2026-11-01T12:00:00.000Z'),counter=100
 const agents=new InMemoryAgentStore(),approvals=new InMemoryAgentApprovalStore(),events=new InMemoryAgentEventStore()
 await agents.createThread({id:thread,workspaceId:actor.workspaceId,createdByUserId:actor.userId,title:'Fixture',status:'active',runtimeKind:'eve',runtimeSessionId:null,createdAt:now})
 await agents.createRun({id:run,threadId:thread,initiatedByUserId:actor.userId,state:'running',executionKind:'forge-native',requestedSelection:{},resolvedConnectionId:null,resolvedModelId:null,reasoningEffort:null,routingPolicyVersion:null,routingReason:null,runtimeRunId:null,inputTokens:0,outputTokens:0,cachedInputTokens:0,costMicros:0,startedAt:null,completedAt:null,errorCode:null})
 const service=new ApprovalService({agents,approvals,events,now:()=>now,id:()=>`00000000-0000-4000-8000-${String(counter++).padStart(12,'0')}`})
 const cases=[]
 for(const step of steps){
  now=new Date(now.getTime()+(step.advance??0));let output
  const capabilityInput=step.changedInput?{...input,slug:'changed'}:input
  const binding={runId:step.wrongRun?thread:run,capabilityId:step.capability??'teams.update',capabilityVersion:step.version??'1',capabilityInput}
  try {
   let value
   if(step.op==='request')value=await service.request(actor,{approvalId,runId:run,capabilityId:step.program?'program.execute':'teams.update',capabilityVersion:'1',risk:'reversible-write',input:step.program?{code:'fixture',capabilityManifest:[{id:'teams.update',version:'1',maximumCalls:1}]}:capabilityInput,redactedInputSummary:step.program?{summary:'Program',details:{programManifest:[{id:'teams.update',version:'1',maximumCalls:1}]}}:{summary:'Update team'},...(step.expiresAfterMs!==undefined?{expiresAt:new Date(now.getTime()+step.expiresAfterMs)}:{})})
   else if(step.op==='resolve')value=await service.resolve(actor,approvalId,step.decision)
   else if(step.op==='consume')value=await service.consume(actor,{approvalId,...binding})
   else value=await service.findApprovedForInvocation(actor,binding)
   output={ok:true,state:(value?.approval??value)?.state??null,eventType:value?.event?.type??null}
  }catch(error){output={ok:false,code:error.code,message:error.message}}
  output.runState=(await agents.getRun(actor.workspaceId,run)).state
  output.storedState=(await approvals.get(approvalId))?.state??null
  output.eventCount=(await events.listRunEvents(run)).length
  cases.push({step,output})
 }
 agentApprovals.flows.push(cases)
}
