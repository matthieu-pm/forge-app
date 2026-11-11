import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {InMemoryAgentStore} from '../apps/forge/src/adapters/agents/in-memory-agent-store.ts'
import {InMemoryAgentEventStore} from '../apps/forge/src/adapters/agents/in-memory-event-store.ts'
import {InMemoryThreadModelPreferenceStore} from '../apps/forge/src/adapters/agents/in-memory-thread-model-preference-store.ts'
import {requireAgentRead,requireAgentRun} from '../apps/forge/src/application/agents/agent-authorization.ts'
import {resolveModel,ModelRoutingError} from '../apps/forge/src/application/agents/model-router.ts'
import {assertAgentRunAllowed,resolveAgentControlPolicy} from '../apps/forge/src/application/agents/agent-control-policy.ts'
import {runtimeApprovalPayloadSchema,localRuntimeApprovalPayloadSchema} from '../apps/forge/src/application/agents/local-runtime-contract.ts'
const source=readFileSync(new URL('../apps/forge/src/application/agents/agent-coordinator.server.ts',import.meta.url),'utf8')
const js=new Bun.Transpiler({loader:'ts'}).transformSync(source).replace(/^import[\s\S]*?;\s*$/gm,'').replace(/\bexport (?=(?:async )?(?:function|class|const))/g,'')
const bindings={randomUUID,requireAgentRead,requireAgentRun,resolveModel,ModelRoutingError,assertAgentRunAllowed,runtimeApprovalPayloadSchema,localRuntimeApprovalPayloadSchema,emitTelemetry:()=>{},correlateIterable:iterable=>iterable}
const AgentCoordinator=new Function(...Object.keys(bindings),js+'\nreturn AgentCoordinator;')(...Object.values(bindings))
export const coordinator={local:[],hosted:[]}
const actor={userId:'fixture-user',workspaceId:'fixture-workspace',workspaceRole:'admin',authentication:{kind:'session',sessionId:'fixture-session'},scopes:null}
const model={selectionId:'local:codex:gpt-codex',connectionId:'00000000-0000-4000-8000-000000000099',executionKind:'external-agent',provider:'openai',modelId:'gpt-codex'}
const runKeys=['state','executionKind','requestedSelection','resolvedModelId','reasoningEffort','routingPolicyVersion','routingReason','runtimeRunId','inputTokens','outputTokens','cachedInputTokens','costMicros','startedAt','completedAt','errorCode']
const threadKeys=['title','status','runtimeKind','runtimeSessionId']
const eventKeys=['sequence','occurredAt','source','type','payload']
const pick=(value,keys)=>Object.fromEntries(keys.map(k=>[k,value[k]]))
const specs=[
  {name:'new-local-turn'},
  {name:'retains-codex-session',runtimeKind:'codex',cursor:'existing-codex-session'},
  {name:'clears-other-runtime-session',cursor:'old-eve-session'},
  {name:'usage-completion',usage:{inputTokens:10.5,outputTokens:2.4,cachedInputTokens:3,costMicros:9},terminal:'run.completed'},
  {name:'failed',terminal:'run.failed',payload:{code:'LOCAL_TEST_ERROR'}},
  {name:'failed-default',terminal:'run.failed',payload:{code:123}},
  {name:'cancelled',terminal:'run.cancelled'},
  {name:'invalid-usage-values',usage:{inputTokens:-1,outputTokens:'3',cachedInputTokens:null,costMicros:0.5}},
]
for(const spec of specs){
 let count=1;const store=new InMemoryAgentStore(),eventStore=new InMemoryAgentEventStore(),preferences=new InMemoryThreadModelPreferenceStore()
 const service=new AgentCoordinator({store,eventStore,preferences,runtimes:[],listModels:async()=>[],now:()=>new Date('2026-11-01T12:00:00.000Z'),id:()=>`00000000-0000-4000-8000-${String(count++).padStart(12,'0')}`})
 const thread=await service.createThread(actor,{runtimeKind:spec.runtimeKind??'eve'})
 if(spec.cursor)await store.updateThread(actor.workspaceId,thread.id,{runtimeSessionId:spec.cursor})
 const input={runtimeId:'codex',threadId:thread.id,message:'Summarize this workspace',model,reasoningEffort:'high',attachmentIds:[]}
 const prepared=await service.prepareLocalTurn(actor,input)
 const initialEvents=prepared.initialEvents.map(e=>pick(e,eventKeys)),initialThread=pick(prepared.thread,threadKeys)
 await service.checkpointLocalRuntime(actor,prepared.run.id,{runtimeSessionId:'codex-thread',runtimeRunId:'codex-turn'})
 const events=[{sourceEventId:'local:delta',source:'codex',type:'assistant.delta',occurredAt:'2026-11-01T12:00:01.000Z',payload:{messageId:'message',delta:'Hello'}}]
 if(spec.usage)events.push({sourceEventId:'local:usage',source:'codex',type:'run.usage',occurredAt:'2026-11-01T12:00:02.000Z',payload:spec.usage})
 if(spec.terminal)events.push({sourceEventId:'local:terminal',source:'codex',type:spec.terminal,occurredAt:'2026-11-01T12:00:03.000Z',payload:spec.payload??{}})
 const ingested=await service.ingestLocalEvents(actor,prepared.run.id,events)
 coordinator.local.push({spec,input,events,initialEvents,initialThread,ingested:ingested.map(e=>pick(e,eventKeys)),run:pick(await store.getRun(actor.workspaceId,prepared.run.id),runKeys),thread:pick(await store.getThread(actor.workspaceId,thread.id),threadKeys),preference:pick(await service.getThreadModelPreference(actor,thread.id),['mode','selectedConnectionId','selectedModelId','selectedEffort'])})
}
const catalog={selectionId:'00000000-0000-4000-8000-000000000066:gpt-5',connectionId:'00000000-0000-4000-8000-000000000066',executionKind:'forge-native',provider:'openai',modelId:'gpt-5',displayName:'gpt-5',providerLabel:'OpenAI',sourceLabel:'Personal API',locality:'server-capable',billingMode:'pay-as-you-go',inputModalities:['text'],supportsTools:true,supportsCode:true,supportedReasoningEfforts:['low','medium','high'],contextWindowTokens:null,status:'available'}
for(const spec of [
 {name:'complete'}, {name:'usage',usage:{inputTokens:10.5,outputTokens:2.4,cachedInputTokens:3,costMicros:9}},
 {name:'waiting',terminal:'run.waiting'}, {name:'failed',terminal:'run.failed'}, {name:'cancelled',terminal:'run.cancelled'},
 {name:'runtime-error',error:true}, {name:'reconnect',error:true,checkpoint:true}, {name:'reconnect-error',error:true,checkpoint:true,reconnectError:true},
 {name:'input-limit',usage:{inputTokens:4},maxInputTokens:3}, {name:'output-limit',usage:{outputTokens:4},maxOutputTokens:3},
]){
 let count=1;const store=new InMemoryAgentStore(),eventStore=new InMemoryAgentEventStore(),preferences=new InMemoryThreadModelPreferenceStore();let cancelled=0
 const incoming=(id,type,payload)=>({sourceEventId:id,source:'eve',type,payload})
 const runtime={kind:'eve',async *start(context){
   if(spec.checkpoint)await context.checkpointRuntimeSession('fixture-cursor')
   yield incoming('eve:delta','assistant.delta',{messageId:'message',delta:'Hello'})
   if(spec.usage)yield incoming('eve:usage','run.usage',spec.usage)
   if(spec.terminal)yield incoming('eve:terminal',spec.terminal,{})
   if(spec.error)throw Error('private-provider-error')
 },async *reconnect(){if(spec.reconnectError)throw Error('private-provider-error');yield incoming('eve:reconnected','assistant.message',{messageId:'message',text:'Hello'})},async cancel(){cancelled++}}
 const controlPolicy={...resolveAgentControlPolicy({}),runWallClockMs:1000,maxInputTokens:spec.maxInputTokens??200000,maxOutputTokens:spec.maxOutputTokens??50000}
 const service=new AgentCoordinator({store,eventStore,preferences,runtimes:[runtime],listModels:async()=>[catalog],controlPolicy,now:()=>new Date('2026-11-01T12:00:00.000Z'),id:()=>`00000000-0000-4000-8000-${String(count++).padStart(12,'0')}`})
 const thread=await service.createThread(actor,{runtimeKind:'eve'})
 const input={threadId:thread.id,message:'Summarize this workspace',selectionMode:'manual',model:pick(catalog,['selectionId','connectionId','executionKind','provider','modelId']),reasoningEffort:'high',attachmentIds:[]}
 const session=await service.startTurn(actor,input);const events=[];for await(const event of session.events)events.push(pick(event,eventKeys))
 coordinator.hosted.push({spec,input,catalog,events,run:pick(await store.getRun(actor.workspaceId,session.run.id),runKeys),thread:pick(await store.getThread(actor.workspaceId,thread.id),threadKeys),cancelled})
}
