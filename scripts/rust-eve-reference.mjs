import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const require=createRequire(new URL('../apps/forge/package.json',import.meta.url));const {z}=require('zod')
function load(path,names,dependencies={}){const source=readFileSync(new URL('../apps/forge/src/adapters/agents/'+path,import.meta.url),'utf8');const js=new Bun.Transpiler({loader:'ts'}).transformSync(source).replace(/^import[\s\S]*?;\s*$/gm,'').replace(/\bexport (?=(?:async )?(?:function|class|const))/g,'');return new Function('z',...Object.keys(dependencies),js+'\nreturn {'+names.join(',')+'};')(z,...Object.values(dependencies))}
const {normalizeEveRuntimeEvent}=load('eve-event-normalizer.ts',['normalizeEveRuntimeEvent']);const {decodeCursor,encodeCursor}=load('eve-runtime.server.ts',['decodeCursor','encodeCursor'])
export const eve={events:[],cursors:[]}
const events=[null,[],true,{}, {type:1},{type:''},{type:'unknown',data:[]},{type:'unknown',data:{}},{type:'unknown',_meta:null},{type:'message.appended'},{type:'message.completed',data:{turnId:null,stepIndex:{},message:'Hello',finishReason:'stop',privateReasoning:'ignored'}},{type:'message.appended',data:{turnId:['a',null,2],stepIndex:2,messageDelta:'👋',sequence:3}},{type:'message.completed',data:{turnId:'turn',stepIndex:0,message:'Done'},_meta:{at:'not-a-date',ignored:true}}]
for(const usage of [undefined,null,{}, {inputTokens:10,outputTokens:7,cacheReadTokens:3,cacheWriteTokens:2,costUsd:0.0000005},{inputTokens:-1},{inputTokens:1.5},{inputTokens:'1'},{inputTokens:9007199254740992},{outputTokens:1,costUsd:0.01234},{costUsd:-1},{costUsd:1e100}])events.push({type:'step.completed',data:{usage}})
for(const tool of [undefined,'bash','execute_program','glob','grep','read_file','write_file','create_artifact','update_team','unknown'])for(const status of [undefined,'completed','failed','rejected']){
 const action={callId:'call',kind:'tool-call',toolName:tool,input:{value:'fixture'},unknown:'kept-only-in-raw'}
 events.push({type:'actions.requested',data:{actions:[action],sequence:4}})
 events.push({type:'action.result',data:{status,result:{...action,output:tool==='create_artifact'?{type:'json',value:{id:'artifact-id',name:'file.txt'}}:{type:'json',value:{calls:[null,{}, {capabilityId:'teams.get',input:{slug:'x'},result:{ok:true}}, {capabilityId:'teams.list'}]}}}}})
}
for(const risk of [undefined,null,'read','reversible-write','important-write','destructive',['destructive'],{}])events.push({type:'authorization.required',data:{risk,input:[],summary:'Approve',expiresAt:'later'}})
for(const tool of ['update_team','execute_program','other'])for(const display of [undefined,'confirmation','select','text','invalid',null]){
 events.push({type:'input.requested',data:{requests:[{requestId:'request',prompt:'Allow?',display,action:{callId:'call',kind:'tool-call',toolName:tool,input:{capabilityManifest:[{id:'teams.update',version:'1'}]}},options:[{id:'approve',label:'Approve',extra:'preserved'}],allowFreeform:false,extra:'preserved'}]}})
}
for(const type of ['turn.cancelled','turn.failed','session.failed','session.waiting'])events.push({type,data:{message:'Private provider diagnostic'},_meta:{at:'2026-11-01T12:00:00.000Z'}})
for(const data of [{actions:[{}]},{actions:[{callId:'',kind:'',input:null}]},{result:{callId:'call',kind:'tool-call',toolName:null}},{requests:[{requestId:'r',prompt:'p',action:{callId:'c',kind:'tool-call',toolName:'x',input:{},unknown:true}}]}])events.push({type:Object.hasOwn(data,'actions')?'actions.requested':Object.hasOwn(data,'result')?'action.result':'input.requested',data})
for(const input of events)for(const index of [undefined,0,7,1.5]){try{eve.events.push({input,index,valid:true,events:normalizeEveRuntimeEvent(input,'session/fixture',index)})}catch{eve.events.push({input,index,valid:false})}}
for(const cursor of [{sessionId:'session',streamIndex:0},{sessionId:'session/日本',continuationToken:'eve:next',streamIndex:9},{sessionId:' ',streamIndex:9007199254740991},{sessionId:'session',continuationToken:'',streamIndex:0},{sessionId:'session',streamIndex:-1},{sessionId:'session',streamIndex:1.5},{sessionId:'session',streamIndex:9007199254740992},{sessionId:'session',streamIndex:0,extra:true},null]){const encoded=Buffer.from(JSON.stringify(cursor)).toString('base64url');const decoded=decodeCursor(encoded);eve.cursors.push({encoded,decoded,canonical:decoded?encodeCursor(decoded):null})}
for(const encoded of ['', 'not-json','e30=','bnVsbA==','W10='])eve.cursors.push({encoded,decoded:decodeCursor(encoded)})

// Run the owning adapter against deterministic HTTP responses, without loading
// application environment modules or credentials. Token signing is checked by
// the Rust HTTP tests; these cases cover delivery, cursor and stream behavior.
const {EveAgentRuntime}=load('eve-runtime.server.ts',['EveAgentRuntime'],{
  normalizeEveRuntimeEvent,
  fetchWithStagingIdentity:(input,init,fetcher)=>fetcher(input,init),
  currentCorrelation:()=>({correlationId:'correlation-fixture'}),
})
const line=value=>JSON.stringify(value)+'\n'
const delta={type:'message.appended',data:{turnId:'turn',stepIndex:0,messageDelta:'Hi 👋',sequence:1}}
const waiting={type:'session.waiting',data:{continuationToken:'next-token'}}
const previous={sessionId:'old/session 日本',continuationToken:'previous-token',streamIndex:12}
const standard=line(delta)+line(delta)+line(waiting)+line({type:'message.appended',data:{messageDelta:'must not emit'}})
const specs=[
  {name:'start',stream:standard},
  {name:'attachments',stream:standard,attachments:[{name:'fixture.txt',contentType:'text/plain',contentBase64:'aGVsbG8='}]},
  {name:'initial-without-continuation',stream:standard,session:{ok:true,sessionId:'new-session'}},
  {name:'existing-fallback-token',stream:standard,cursor:previous,session:{ok:true,sessionId:'new-session'}},
  {name:'resume',mode:'resume',cursor:previous,stream:line(waiting)},
  {name:'resume-missing-token',mode:'resume',cursor:{sessionId:'old',streamIndex:1}},
  {name:'resume-missing-cursor',mode:'resume'},
  {name:'reconnect',mode:'reconnect',cursor:previous,stream:standard},
  {name:'reconnect-without-token',mode:'reconnect',cursor:{sessionId:'old',streamIndex:2},stream:standard},
  {name:'reconnect-missing-cursor',mode:'reconnect'},
  {name:'invalid-cursor-starts-new',cursor:{sessionId:'',streamIndex:0},stream:standard},
  {name:'cancelled',stream:line({type:'turn.cancelled'})+line(delta)},
  {name:'turn-failed',stream:line({type:'turn.failed',data:{message:'private diagnostic'}})+line(delta)},
  {name:'session-failed',stream:line({type:'session.failed'})+line(delta)},
  {name:'eof-drops-incomplete-line',stream:line(delta)+JSON.stringify(delta)},
  {name:'empty',stream:''},
  {name:'blank-unknown-lines',stream:'\ufeff \n\t\n'+line({type:'unknown'})+line(delta)+line(waiting)},
  {name:'invalid-json',stream:line(delta)+'{bad}\n'},
  {name:'invalid-basic',stream:line(delta)+line({type:'unknown',data:[]})},
  {name:'invalid-normalized',stream:line(delta)+line({type:'step.completed',data:{usage:{inputTokens:-1}}})},
  {name:'checkpoint-initial-failure',stream:standard,failCheckpoint:1},
  {name:'checkpoint-event-failure',stream:standard,failCheckpoint:2},
  {name:'delivery-http-failure',deliveryStatus:500},
  {name:'stream-http-failure',streamStatus:500},
  {name:'invalid-session',session:{ok:true,sessionId:'new-session',continuationToken:null}},
]
eve.flows=[]
for(const spec of specs){
  const requests=[],checkpoints=[],events=[];let error=false
  const runtime=new EveAgentRuntime({baseUrl:'http://runtime.test',channelSecret:'fixture',fetcher:async(input,init={})=>{
    const url=new URL(input);requests.push({path:url.pathname+url.search,method:init.method??'GET',body:init.body?JSON.parse(init.body):null,correlation:new Headers(init.headers).get('x-correlation-id')})
    if(url.pathname.endsWith('/stream'))return new Response(new TextEncoder().encode(spec.stream??''),{status:spec.streamStatus??200,headers:{'content-type':'application/x-ndjson'}})
    return Response.json(spec.session??{ok:true,sessionId:'new-session',continuationToken:'initial-token'},{status:spec.deliveryStatus??202})
  }})
  runtime.createChannelToken=async()=> 'fixture-channel'
  const input={threadId:'thread-fixture',runId:'run-fixture',identity:{workspaceId:'workspace-fixture',userId:'user-fixture',workspaceRole:'owner'},model:{connectionId:'connection-fixture',provider:'openai',modelId:'gpt-fixture'},reasoningEffort:'high',runtimeSessionId:spec.cursor?encodeCursor(spec.cursor):null,message:'Hello',attachments:spec.attachments??[],inputResponses:[{requestId:'request-fixture',optionId:'approve'}],checkpointRuntimeSession:async encoded=>{checkpoints.push(JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')));if(checkpoints.length===spec.failCheckpoint)throw new Error('fixture checkpoint failure')}}
  try{for await(const event of runtime[spec.mode??'start'](input))events.push(event)}catch{error=true}
  eve.flows.push({spec,requests,checkpoints,events,error})
}
