import {readFileSync} from 'node:fs'
import {createHash,createCipheriv,createDecipheriv} from 'node:crypto'
import {isIP} from 'node:net'
function load(path,names,dependencies={}){
 const source=readFileSync(new URL('../apps/forge/src/'+path,import.meta.url),'utf8')
 const js=new Bun.Transpiler({loader:'ts'}).transformSync(source).replace(/^import[\s\S]*?;\s*$/gm,'').replace(/\bexport (?=(?:async )?(?:function|class|const))/g,'')
 return new Function(...Object.keys(dependencies),js+'\nreturn {'+names.join(',')+'};')(...Object.values(dependencies))
}
export const modelProviders={vault:[],catalogs:[],addresses:[],endpoints:[],managed:[]}
const nonce=Buffer.from(Array.from({length:12},(_,i)=>i)),key=Buffer.from(Array.from({length:32},(_,i)=>i)).toString('base64')
const {EnvelopeModelSecretVault}=load('application/agents/model-secret-vault.server.ts',['EnvelopeModelSecretVault'],{createCipheriv,createDecipheriv,randomBytes:()=>nonce})
for(const secret of ['fixture-api-secret','Unicode credential 👋','', 'x'.repeat(256)])for(const context of ['workspace:connection','équipe:日本','']){
 const vault=new EnvelopeModelSecretVault(key);modelProviders.vault.push({key,nonce:[...nonce],secret,context,reference:await vault.seal(secret,context)})
}
const endpoint=load('application/agents/custom-endpoint-policy.server.ts',['isPrivateAddress','resolveServerProviderEndpoint'],{isIP,lookup:async()=>[{address:'8.8.8.8',family:4}]})
for(const address of ['0.0.0.0','8.8.8.8','10.0.0.1','100.63.0.1','100.64.0.1','100.127.0.1','100.128.0.1','127.2.3.4','169.254.1.1','172.15.1.1','172.16.1.1','172.31.1.1','172.32.1.1','192.0.1.1','192.88.99.1','192.88.100.1','192.168.1.1','198.18.0.1','198.19.1.1','198.51.100.1','203.0.113.1','223.0.0.1','224.0.0.1','255.255.255.255','::','::1','fc00::1','fd00::1','fe80::1','febf::1','fec0::1','feff::1','ff00::1','2001:db8::1','2001:4860:4860::8888','::ffff:8.8.8.8','not-an-ip'])modelProviders.addresses.push({address,private:endpoint.isPrivateAddress(address)})
for(const value of ['https://example.test','https://example.test/v1','https://example.test/v1/?key=secret#fragment','https://example.test:443/v1','https://example.test:444/v1','http://example.test','https://u:p@example.test','https://example.test/a%20b','https://例え.テスト/v1','bad']){try{modelProviders.endpoints.push({input:value,valid:true,url:(await endpoint.resolveServerProviderEndpoint(value)).url.toString()})}catch{modelProviders.endpoints.push({input:value,valid:false})}}
const catalog=load('adapters/agents/provider-catalogs/api-provider-catalog.server.ts',['discoverApiProviderModels'],{Agent:class {async close(){}},createPinnedEndpointLookup:()=>()=>{},resolveServerProviderEndpoint:async(value)=>({url:new URL(value),addresses:[{address:'8.8.8.8',family:4}]})})
const payloads=[{},null,{data:[null,false,3,{},[],{id:' gpt-5 '},{id:'o3-mini'},{name:'models/gemini-pro'},{id:'embedding-3'},{id:'claude-sonnet'},{id:'audio-text'},{id:'gpt-5'},{id:''},{name:'models/x'},{id:1,name:'models/éclair'},{id:'A'},{id:'a'},{id:'😀'}]},{models:[{name:'models/deepseek-chat'},{id:'mistral-large'},{id:'grok-4'},{id:'minimax-m2'},{id:'kimi-thinking'},{id:'codex'},{id:'o10'},{id:'o4-mini'}]},{data:[],models:[{id:'ignored'}]},{data:Array.from({length:260},(_,i)=>({id:'model-'+i}))}]
for(const provider of ['openai','anthropic','google','minimax','mistral','xai','deepseek','kimi','custom-openai','custom-anthropic'])for(const payload of payloads)for(const fail of [false,true]){
 const manual=['manual','manual','embedding-manual',' Z '];let request
 const models=await catalog.discoverApiProviderModels({provider,apiKey:'fixture-key',endpointUrl:'https://provider.test/v1/',modelIds:manual},{fetcher:async(url,options)=>{request={url:url.toString(),headers:options.headers,redirect:options.redirect};if(fail)throw new Error('fixture');return new Response(JSON.stringify(payload))}})
 modelProviders.catalogs.push({provider,payload:fail?null:payload,manual,models,request})
}
const managed=load('application/agents/managed-openai-models.server.ts',['managedOpenAIConnectionIdForWorkspace','listManagedOpenAIModels','managedOpenAIApiKeyFor'],{createHash})
for(const workspace of ['w','workspace:fixture','équipe/日本',''])for(const env of [{},{OPENAI_API_KEY:' '},{OPENAI_API_KEY:' fixture-managed '},{OPENAI_API_KEY:'fixture',FORGE_MANAGED_OPENAI_MODELS:'model-a, model-b,model-a, bad/id, :bad,, é, gpt-5'},{OPENAI_API_KEY:'fixture',FORGE_MANAGED_OPENAI_MODELS:'bad/id'},{OPENAI_API_KEY:'fixture',FORGE_MANAGED_OPENAI_MODELS:Array.from({length:55},(_,i)=>'model-'+i).join(',')}]){
 const id=managed.managedOpenAIConnectionIdForWorkspace(workspace),models=managed.listManagedOpenAIModels(id,env)
 modelProviders.managed.push({workspace,env,id,models,key:managed.managedOpenAIApiKeyFor(id,workspace,'openai',models[0]?.modelId??'missing',env)})
}
