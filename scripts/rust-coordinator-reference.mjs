import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {InMemoryAgentStore} from '../apps/forge/src/adapters/agents/in-memory-agent-store.ts'
import {InMemoryAgentEventStore} from '../apps/forge/src/adapters/agents/in-memory-event-store.ts'
import {InMemoryThreadModelPreferenceStore} from '../apps/forge/src/adapters/agents/in-memory-thread-model-preference-store.ts'
import {requireAgentRead,requireAgentRun} from '../apps/forge/src/application/agents/agent-authorization.ts'
import {resolveModel} from '../apps/forge/src/application/agents/model-router.ts'
const source=readFileSync(new URL('../apps/forge/src/application/agents/agent-coordinator.server.ts',import.meta.url),'utf8')
const js=new Bun.Transpiler({loader:'ts'}).transformSync(source).replace(/^import[\s\S]*?;\s*$/gm,'').replace(/\bexport (?=(?:async )?(?:function|class|const))/g,'')
const AgentCoordinator=new Function('randomUUID','requireAgentRead','requireAgentRun','resolveModel',js+'\nreturn AgentCoordinator;')(randomUUID,requireAgentRead,requireAgentRun,resolveModel)
export const coordinator={local:[]}
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
