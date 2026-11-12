// Execute the owning provider code with in-memory tokens and no network access.
import { mock } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import * as calls from '../apps/forge/src/lib/calls.ts'
import { STAGING, assertStagingEnvironment } from '../packages/environment/staging-environment.ts'
import { PREVIEW, previewPeerOrigin } from '../packages/environment/preview-environment.ts'
import { STAGING_CREDENTIAL_DIGESTS, STAGING_INTEGRATIONS } from '../packages/environment/staging-credentials.ts'
mock.module('@tanstack/react-start/server-only',()=>({}))
mock.module('@/lib/calls',()=>calls)
const provider = await import('../apps/forge/src/application/calls/providers.server.ts')
const savedEnv = process.env
const now = 1893456000000
Date.now = () => now
let captured, responseBody
const savedFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  captured={url:String(url),method:options.method,headers:options.headers,form:Object.fromEntries(options.body)}
  return new Response(JSON.stringify(responseBody),{status:200})
}
const environment={BETTER_AUTH_URL:'https://forge.example.test/base',FORGE_MODEL_CREDENTIAL_KEK:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='}
for(const prefix of ['GOOGLE_MEET','MICROSOFT_TEAMS','ZOOM'])Object.assign(environment,{[`FORGE_${prefix}_CLIENT_ID`]:'fixture client+id',[`FORGE_${prefix}_CLIENT_SECRET`]:'fixture:secret&only'})
const authorization=[],tokens=[],configuration=[]
try {
 process.env=environment
 for(const name of ['google','teams','zoom']){
  for(const state of ['state','state +/?&語'])authorization.push({provider:name,state,challenge:'pkce-challenge',output:provider.authorizationUrl(name,state,'pkce-challenge')})
  for(const input of [{code:'code +&語',verifier:'verifier-1'},{refreshToken:'old-refresh-token'}])for(const data of [{access_token:'new-token'}, {access_token:'new-token',refresh_token:'new-refresh',expires_in:60},{access_token:'new-token',refresh_token:null,expires_in:0},{access_token:'new-token',expires_in:1.25},{access_token:''},{}]){
   responseBody=data;captured=null
   try{tokens.push({provider:name,input,data,valid:true,output:await provider.exchangeTokens(name,input),request:captured})}
   catch{tokens.push({provider:name,input,data,valid:false,request:captured})}
  }
 }
 for(const patch of [{FORGE_CALLS_ENABLED:'false'},{FORGE_CALLS_PROVIDERS:'zoom'},{FORGE_CALLS_PROVIDERS:''},{BETTER_AUTH_URL:''},{FORGE_GOOGLE_MEET_CLIENT_ID:''},{FORGE_GOOGLE_MEET_CLIENT_SECRET:''},{FORGE_ENVIRONMENT:'staging'},{FORGE_RESOURCE_PROFILE:'preview'},{BETTER_AUTH_URL:'not a url'}]){
  process.env={...environment,...patch}
  try{configuration.push({input:process.env,valid:true,output:provider.authorizationUrl('google','state','challenge')})}
  catch{configuration.push({input:process.env,valid:false})}
 }
} finally {process.env=savedEnv;globalThis.fetch=savedFetch}
const staging={FORGE_ENVIRONMENT:'staging',FORGE_EXTERNAL_INTEGRATIONS:'disabled',FORGE_AGENT_CHANNEL_SECRET:'x'.repeat(32),BETTER_AUTH_URL:STAGING.webOrigin,EVE_AGENT_RUNTIME_URL:STAGING.runtimeOrigin,FORGE_AGENT_BLOB_ADAPTER:'vercel-private',BLOB_STORE_ID:STAGING.blobStoreId,FORGE_BILLING_ENABLED:'false',FORGE_BILLING_WEBHOOKS_ENABLED:'false',DATABASE_URL:`postgresql://${STAGING.databaseRole}:fixture@${STAGING.database.host.replace('.','-pooler.')}/${STAGING.database.database}?sslmode=require`}
const preview={FORGE_RESOURCE_PROFILE:'preview',FORGE_ENVIRONMENT:'staging',FORGE_EXTERNAL_INTEGRATIONS:'disabled',FORGE_AGENT_CHANNEL_SECRET:'x'.repeat(32),VERCEL_ENV:'preview',VERCEL_PROJECT_ID:PREVIEW.webProjectId,VERCEL_RELATED_PROJECTS:JSON.stringify([{project:{id:PREVIEW.runtimeProjectId},preview:{branch:'peer-branch.vercel.app'}}]),FORGE_AGENT_BLOB_ADAPTER:'vercel-private',BLOB_STORE_ID:PREVIEW.blobStoreId,FORGE_BILLING_ENABLED:'false',FORGE_BILLING_WEBHOOKS_ENABLED:'false',FORGE_CALLS_ENABLED:'false',DATABASE_URL:`postgresql://${PREVIEW.databaseRole}:fixture@${PREVIEW.database.host}/${PREVIEW.database.database}?sslmode=verify-full`}
const deployment=[]
const add=(input,service)=>{let valid=true;try{assertStagingEnvironment(input,service)}catch{valid=false}deployment.push({input,service,valid,peer:previewPeerOrigin(input)??null})}
for(const service of ['web','runtime']){
 for(const base of [{},staging,{...staging,FORGE_EXTERNAL_INTEGRATIONS:'sandbox'},preview,{...preview,VERCEL_PROJECT_ID:PREVIEW.runtimeProjectId,VERCEL_RELATED_PROJECTS:JSON.stringify([{project:{id:PREVIEW.webProjectId},preview:{branch:'web-peer.vercel.app'}}]),FORGE_APP_ORIGIN:STAGING.webOrigin}]){
  add(base,service)
  for(const key of Object.keys(base))for(const value of ['', 'wrong'])add({...base,[key]:value},service)
  for(const [key,value] of Object.entries({VERCEL:'1',EVE_EVAL_FIXTURE_MODE:'true',AGENT_FAKE_RUNTIME_ENABLED:'true',OPENAI_API_KEY:'fixture-not-registered',FORGE_GOOGLE_MEET_CLIENT_ID:STAGING_INTEGRATIONS.googleClientId,FORGE_ZOOM_CLIENT_ID:STAGING_INTEGRATIONS.zoomClientId,FORGE_MICROSOFT_TEAMS_CLIENT_SECRET:'fixture',FORGE_AGENT_CHANNEL_SECRET:'🙂'.repeat(16),FORGE_APP_ORIGIN:STAGING.webOrigin}))add({...base,[key]:value},service)
  for(const tail of ['?sslmode=disable','?sslmode=require&sslmode=require','?sslmode=require&unknown=x','?sslmode=require&channel_binding=require','#fragment'])if(base.DATABASE_URL)add({...base,DATABASE_URL:base.DATABASE_URL.split('?')[0]+tail},service)
 }
}
function save(file,value){const output=JSON.stringify(value,null,2)+'\n';const path=new URL(file,import.meta.url);if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error(`Provider reference changed: ${file}`)}else writeFileSync(path,output)}
save('../rust/crates/forge-core/data/deployment-policy.json',{staging:STAGING,preview:PREVIEW,digests:STAGING_CREDENTIAL_DIGESTS,integrations:STAGING_INTEGRATIONS})
save('../rust/crates/forge-core/data/call-provider-reference.json',{now,environment,authorization,tokens,configuration,deployment})
console.log(`Call provider reference: ${authorization.length} authorizations, ${tokens.length} token exchanges, ${configuration.length} configurations, ${deployment.length} isolation cases`)
