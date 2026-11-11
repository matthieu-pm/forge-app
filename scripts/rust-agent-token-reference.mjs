import {readFileSync} from 'node:fs'
import {createHmac} from 'node:crypto'
import {z} from '../apps/forge/node_modules/zod/index.js'
import {SignJWT,jwtVerify} from '../apps/forge/node_modules/jose/dist/webapi/index.js'
import {secs} from '../apps/forge/node_modules/jose/dist/webapi/lib/jwt_claims_set.js'
const now=1793491200,id='00000000-0000-4000-8000-000000000001',thread='00000000-0000-4000-8000-000000000002',nonce='00000000-0000-4000-8000-000000000003'
const secret='public-agent-fixture-secret-1234567890'
const actor={userId:'fixture-user',workspaceId:'fixture-workspace',workspaceRole:'admin',authentication:{kind:'session',sessionId:'fixture-session'},scopes:null}
const env={FORGE_AGENT_CAPABILITY_SECRET:secret,FORGE_AGENT_LOCAL_INGEST_SECRET:secret,FORGE_AGENT_MODEL_ACCESS_SECRET:secret,FORGE_AGENT_ARTIFACT_SECRET:secret}
class FixedJWT extends SignJWT{setIssuedAt(){return super.setIssuedAt(now)}setExpirationTime(input){return super.setExpirationTime(typeof input==='string'?now+secs(input):input)}}
function load(file,names){const source=readFileSync(new URL('../apps/forge/src/application/agents/'+file,import.meta.url),'utf8');const js=new Bun.Transpiler({loader:'ts'}).transformSync(source).replace(/^import[\s\S]*?;\s*$/gm,'').replace(/\bexport (?=(?:async )?(?:function|class|const))/g,'');return new Function('SignJWT','jwtVerify','z','crypto','process',js+'\nreturn {'+names.join(',')+'};')(FixedJWT,(token,key,options)=>jwtVerify(token,key,{...options,currentDate:new Date(now*1000)}),z,{randomUUID:()=>nonce},{env})}
const capability=load('run-token.server.ts',['mintAgentCapabilityToken','verifyAgentCapabilityToken'])
const local=load('local-ingest-token.server.ts',['mintLocalIngestToken','verifyLocalIngestToken'])
const model=load('model-access-token.server.ts',['mintAgentModelAccessToken','verifyAgentModelAccessToken'])
const artifact=load('artifact-access-token.server.ts',['mintArtifactAccessToken','verifyArtifactAccessToken'])
export const agentTokens={mint:[],verify:[],binding:[],scopes:[]}
const capabilities=['teams.list','workspace.describe','teams.update','artifacts.create']
const inputs={capability:{actor,runId:id,capabilities},local:{actor,runId:id,threadId:thread},model:{actor,runId:id,connectionId:thread,provider:'openai',modelId:'gpt-6-sol'},artifact:{}}
const mint=(kind,expires)=>kind==='capability'?capability.mintAgentCapabilityToken({...inputs.capability,expiresInSeconds:expires}):kind==='local'?local.mintLocalIngestToken({...inputs.local,expiresInSeconds:expires}):kind==='model'?model.mintAgentModelAccessToken({...inputs.model,expiresInSeconds:expires}):artifact.mintArtifactAccessToken(actor,id,expires)
const verify=(kind,token,expected={})=>kind==='capability'?capability.verifyAgentCapabilityToken(token,{runId:id,workspaceId:actor.workspaceId,capabilityId:'teams.list',...expected}):kind==='local'?local.verifyLocalIngestToken(token,{actor,runId:id,threadId:thread,...expected}):kind==='model'?model.verifyAgentModelAccessToken(token):artifact.verifyArtifactAccessToken(token,expected.actor??actor,expected.artifactId??id)
const payload=token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString())
const encode=(claims,header={alg:'HS256',typ:'JWT'})=>{const p=[header,claims].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');return p+'.'+createHmac('sha256',secret).update(p).digest('base64url')}
for(const kind of ['capability','local','model','artifact']){
 const sample=await mint(kind,300),base=payload(sample);const claims={...base};for(const key of ['iss','aud','jti','iat','exp'])delete claims[key]
 for(const expires of [-1,0,0.1,29.9,30,30.5,300,900,1e20,1e21]){let token=null,error=false;try{token=await mint(kind,expires)}catch{error=true}agentTokens.mint.push({kind,secret,now,claims,expires,token,error})}
 const cases=[base,...['iss','aud','sub','workspaceId','runId','threadId','tokenId','scopes','capabilities','iat','exp','nbf'].flatMap(key=>{if(!(key in base)&&key!=='nbf')return [];const missing={...base};delete missing[key];return [missing,...[null,1,'wrong',[],{}].map(value=>({...base,[key]:value}))]}),{...base,iat:now+100},{...base,iat:now-300},{...base,iat:now-301},{...base,exp:now},{...base,exp:now+1},{...base,nbf:now},{...base,nbf:now+1},{...base,aud:['other',base.aud]},{...base,extra:'stripped'}]
 for(const claims of cases){const token=encode(claims);let valid=true;try{await verify(kind,token)}catch{valid=false}agentTokens.verify.push({kind,secret,now,token,valid})}
 for(const header of [{alg:'none'},{alg:'HS512'},{alg:'HS256'},{alg:'HS256',typ:'other'},{alg:'HS256',crit:[]},{alg:'HS256',crit:['unknown'],unknown:true},{alg:'HS256',crit:['b64'],b64:true},{alg:'HS256',crit:['b64'],b64:false},{alg:'HS256',b64:false}]){const token=encode(base,header);let valid=true;try{await verify(kind,token)}catch{valid=false}agentTokens.verify.push({kind,secret,now,token,valid})}
 for(const token of ['',sample+'x',sample.split('.').slice(0,2).join('.'),sample.replace(/.$/,'!')]){let valid=true;try{await verify(kind,token)}catch{valid=false}agentTokens.verify.push({kind,secret,now,token,valid})}
 if(kind!=='model')for(const expected of kind==='capability'?[{runId:thread},{workspaceId:'other'},{capabilityId:'admin.grant'}]:kind==='local'?[{runId:thread},{threadId:id},{threadId:''},{actor:{...actor,userId:'other'}},{actor:{...actor,workspaceId:'other'}}]:[{artifactId:thread},{actor:{...actor,userId:'other'}},{actor:{...actor,workspaceId:'other'}}]){let valid=true;try{await verify(kind,sample,expected)}catch{valid=false}agentTokens.binding.push({kind,secret,now,token:sample,actor,runId:id,threadId:thread,artifactId:id,expected,valid})}
}
for(const capabilities of [[],['teams.get'],['teams.update'],['workspace.describe'],['artifacts.create'],['issues.read'],['teams.update','teams.update','artifacts.create'],['Teams.list'],['teams.']]){const token=await capability.mintAgentCapabilityToken({actor,runId:id,capabilities});agentTokens.scopes.push({capabilities,scopes:payload(token).scopes})}
