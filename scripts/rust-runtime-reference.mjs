import {readFileSync} from 'node:fs'
import {createHmac} from 'node:crypto'
import {z} from '../services/agent-runtime/node_modules/zod/index.js'
import {jwtVerify} from '../services/agent-runtime/node_modules/jose/dist/webapi/index.js'
import {runCodeInputSchema} from '../services/agent-runtime/src/code-runtime.ts'
import {capabilityManifestEntrySchema} from '../services/agent-runtime/src/program-runtime.ts'
const now=1793491200,secret='public-runtime-fixture-secret-1234567890'
const run='00000000-0000-4000-8000-000000000001',correlation='00000000-0000-4000-8000-000000000002'
function load(file,names,injections){const source=readFileSync(new URL('../services/agent-runtime/src/'+file,import.meta.url),'utf8');const js=new Bun.Transpiler({loader:'ts'}).transformSync(source).replace(/^import[\s\S]*?;\s*$/gm,'').replace(/\bexport (?=(?:async )?(?:function|class|const))/g,'');return new Function(...Object.keys(injections),js+'\nreturn {'+names.join(',')+'};')(...Object.values(injections))}
const {verifyForgeChannelRequest}=load('forge-auth.ts',['verifyForgeChannelRequest'],{z,jwtVerify:(token,key,options)=>jwtVerify(token,key,{...options,currentDate:new Date(now*1000)}),emitTelemetry:()=>{},process:{env:{FORGE_AGENT_CHANNEL_SECRET:secret}}})
const claims={sub:'fixture-user',workspaceId:'fixture-workspace',runId:run,forgeCapabilityToken:'public-fixture-capability-token',forgeModelAccessToken:'public-fixture-model-token',provider:'openai',modelId:'gpt-5',reasoningEffort:'high',iss:'forge',aud:'forge-agent-runtime',iat:now,exp:now+300}
const encode=(claims,header={alg:'HS256'})=>{const body=[header,claims].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');return body+'.'+createHmac('sha256',secret).update(body).digest('base64url')}
const auth=[]
for(const candidate of [claims,{...claims,correlationId:correlation,extra:'stripped'},...Object.keys(claims).flatMap(key=>{const missing={...claims};delete missing[key];return [missing,...[null,'',1,{}].map(value=>({...claims,[key]:value}))]}),{...claims,nbf:now+1},{...claims,exp:now},{...claims,aud:['other',claims.aud]}]){
 const authorization='Bearer '+encode(candidate),result=await verifyForgeChannelRequest(new Request('https://fixture.test',{headers:{authorization}}));auth.push({secret,now,authorization,result})
}
for(const authorization of ['','bearer '+encode(claims),'Bearer broken','Bearer '+encode(claims,{alg:'none'}),'Bearer '+encode(claims)+'x','Bearer   '+encode(claims)])auth.push({secret,now,authorization,result:await verifyForgeChannelRequest(new Request('https://fixture.test',{headers:{authorization}}))})
const code={language:'javascript',code:'console.log(42)'},file={path:'input/data.json',content:'{}'}
const codeCases=[code,...['typescript','shell','python',null].map(language=>({...code,language})),{...code,unknown:true},{...code,code:''},...[null,0,99,100,30000,30001,100.5,'1000'].map(timeoutMs=>({...code,timeoutMs})),{...code,files:[file]},{...code,files:null},{...code,files:[{...file,extra:true}]},...['../escape','/escape','end/','a/../b','a//b','./data','a\\b','a b','a.../b','😀','.', '..'].map(path=>({...code,files:[{...file,path}]}))]
const parse=(schema,value)=>{const result=schema.safeParse(value);return {input:value,valid:result.success,...result.success?{result:result.data}:{}}}
const manifest={id:'teams.list',version:'1',maximumCalls:1}
const manifests=[manifest,{...manifest,extra:true},...[0,20,21,1.5,null].map(maximumCalls=>({...manifest,maximumCalls})),{...manifest,id:''},{...manifest,version:1}].map(v=>parse(capabilityManifestEntrySchema,v))
const programFlows=[]
const output=result=>'__FORGE_OUTPUT__'+JSON.stringify({result})+'\n'
const call=(n,id='teams.list',input={limit:10},key)=>'__FORGE_CALL__'+JSON.stringify({callIndex:n,capabilityId:id,input,idempotencyKey:key})+'\n'
for(const sample of [
 {outputs:[call(0),output({names:['Forge']})],responses:[{items:[{name:'Forge'}],nextCursor:null}]},
 {outputs:[output(null)]},
 {outputs:[call(0,'teams.update',{slug:'forge',settings:{description:'Updated'}},'write-1'),output({updated:true})],manifest:[{id:'teams.update',version:'1',maximumCalls:1}],responses:[{name:'Forge'}]},
 {outputs:[call(1)]}, {outputs:[call(0,'teams.delete')]}, {outputs:['no output']},
 {outputs:[output(42)],manifest:[{id:'teams.delete',version:'1',maximumCalls:1}]},
 {outputs:['__FORGE_CALL__not-json']},
 {outputs:[call(0),call(1,'teams.get',{slug:'forge'}),output({ok:true})],manifest:[manifest,{id:'teams.get',version:'1',maximumCalls:1}],responses:[{items:[]},{name:'Forge'}]},
]){
 const requests=[],states=[],commands=[];let executions=0,removed=0
 const {executeProgram}=load('program-runtime.ts',['executeProgram'],{z,crypto:{randomUUID:()=>run},callForgeCapability:async(_caller,request)=>{requests.push(request);return sample.responses?.[requests.length-1]??null}})
 const input={language:'javascript',code:'return 42',capabilityManifest:sample.manifest??[manifest],timeoutMs:1000}
 const sandbox={writeTextFile:async({path,content})=>{if(path.endsWith('/state.json'))states.push(JSON.parse(content))},run:async({command})=>{commands.push(command);return {stdout:sample.outputs[executions++]??'',stderr:'',exitCode:0}},removePath:async()=>{removed++}}
 let result=null,failed=false;try{result=await executeProgram({sandbox,caller:{workspaceId:claims.workspaceId,runId:run,capabilityToken:claims.forgeCapabilityToken},input})}catch{failed=true}
 programFlows.push({input,outputs:sample.outputs,responses:sample.responses??[],requests,states,commands,executions,removed,result,failed})
}
export const runtimeService={auth,code:codeCases.map(v=>parse(runCodeInputSchema,v)),manifests,programFlows}
