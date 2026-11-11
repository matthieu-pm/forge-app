import {createOpenAI} from '../services/agent-runtime/node_modules/@ai-sdk/openai/dist/index.js'
import {createAnthropic} from '../services/agent-runtime/node_modules/@ai-sdk/anthropic/dist/index.js'
const simple=[{role:'system',content:'You are Forge.'},{role:'user',content:[{type:'text',text:'Hello'}]}]
const tool={type:'function',name:'get_team',description:'Get a Forge team.',inputSchema:{type:'object',properties:{slug:{type:'string'}},required:['slug'],additionalProperties:false}}
const history=[...simple,{role:'assistant',content:[{type:'text',text:'Checking.'},{type:'tool-call',toolCallId:'call_fixture',toolName:'get_team',input:{slug:'forge'}}]},{role:'tool',content:[{type:'tool-result',toolCallId:'call_fixture',toolName:'get_team',output:{type:'json',value:{name:'Forge',active:true}}}]}]
const prompts=[simple,history,[...simple,{role:'assistant',content:[{type:'tool-call',toolCallId:'call_fixture',toolName:'get_team',input:{slug:'forge'}}]},{role:'tool',content:[{type:'tool-result',toolCallId:'call_fixture',toolName:'get_team',output:{type:'execution-denied'}}]}],[{role:'system',content:'One'},{role:'system',content:'Two'},{role:'user',content:[{type:'text',text:'A'},{type:'text',text:'B'}]}],[...simple.slice(0,1),{role:'user',content:[{type:'text',text:'Read this'},{type:'file',data:{type:'data',data:'SGVsbG8='},mediaType:'application/pdf',filename:'report.pdf'}]}],[...simple.slice(0,1),{role:'user',content:[{type:'file',data:{type:'data',data:'aW1hZ2U='},mediaType:'image/png',filename:'image.png'}]}]]
const outputPrompt = (output) => [...history.slice(0,-1), {role:'tool',content:[{type:'tool-result',toolCallId:'call_fixture',toolName:'get_team',output}]}]
prompts.push(
  outputPrompt({type:'text',value:'Result'}),
  outputPrompt({type:'error-text',value:'Unavailable'}),
  outputPrompt({type:'error-json',value:{message:'Unavailable'}}),
  outputPrompt({type:'execution-denied',reason:'User declined.'}),
  outputPrompt({type:'content',value:[{type:'text',text:'Result'}]}),
  [...simple,{role:'user',content:[{type:'text',text:'Again'}]},{role:'assistant',content:[{type:'text',text:' A '}]},{role:'assistant',content:[{type:'text',text:' B \ufeff'}]}],
  [...simple,{role:'user',content:[{type:'file',data:{type:'data',data:'SGVsbG8='},mediaType:'application/pdf'}]}],
)
export const modelRuntime=[]
async function capture(provider,modelId,prompt,tools=[],maxOutputTokens,temperature){
  let request=null
  const options={baseURL:'https://forge.test/api/agent/runtime/model',apiKey:'forge-run-bound-proxy',headers:{authorization:'Bearer public-fixture-run-model-token','x-correlation-id':'00000000-0000-4000-8000-000000000001'},fetch:async(url,init)=>{request={path:new URL(url).pathname,body:JSON.parse(init.body)};return new Response('',{headers:{'content-type':'text/event-stream'}})}}
  const model=provider.includes('anthropic')?createAnthropic(options)(modelId):provider==='openai'?createOpenAI(options)(modelId):createOpenAI(options).chat(modelId)
  const input={provider,modelId,prompt,tools,...maxOutputTokens===undefined?{}:{maxOutputTokens},...temperature===undefined?{}:{temperature}}
  const hydrate=(value)=>Array.isArray(value)?value.map(hydrate):value&&typeof value==='object'?value.type==='file'&&value.data?.type==='data'?{...value,data:{...value.data,data:Buffer.from(value.data.data,'base64')}}:Object.fromEntries(Object.entries(value).map(([key,item])=>[key,hydrate(item)])):value
  const hydrated=hydrate(prompt)
  let failed=false;try{const result=await model.doStream({prompt:hydrated,maxOutputTokens,temperature,...tools.length?{tools,toolChoice:{type:'auto'}}:{}});for await(const _ of result.stream){}}catch{failed=true}
  modelRuntime.push({input,request,failed})
}
for(const [provider,modelId] of [['openai','gpt-5.6-luna'],['openai','gpt-4o'],['custom-openai','deepseek-chat'],['custom-openai','gpt-5.6-luna'],['anthropic','claude-sonnet-4-5'],['custom-anthropic','custom-model']]){
  for(const prompt of prompts)for(const includeTools of [false,true])await capture(provider,modelId,prompt,includeTools?[tool]:[],1024)
}
for(const provider of ['openai','custom-openai']){
  for(const model of ['o3','o4-mini','gpt-5','gpt-5-chat-latest','gpt-5.6-chat-latest','gpt-4o'])for(const max of [undefined,50000])await capture(provider,model,simple,[],max)
}
for(const model of ['claude-opus-5','claude-opus-4-7','claude-sonnet-4-6','claude-sonnet-4-5','claude-opus-4-5','claude-opus-4-1','claude-sonnet-4-0','claude-opus-4-0','claude-3-haiku','claude-3-5-sonnet','claude-2.1','claude-instant-1','claude-future','custom-model'])for(const max of [undefined,200000])await capture('anthropic',model,simple,[],max)

for(const [provider,model] of [['openai','gpt-5.6-luna'],['anthropic','claude-sonnet-4-5']]) {
 for(const file of [{mediaType:'image/png'}, {mediaType:'application/pdf'}, {mediaType:'application/pdf',filename:'report.pdf'}])await capture(provider,model,outputPrompt({type:'content',value:[{type:'file',data:{type:'data',data:'SGVsbG8='},...file}]}),[],1024)
 await capture(provider,model,[...simple,{role:'assistant',content:[{type:'reasoning',text:'Reasoning',providerOptions:{openai:{itemId:'rs_fixture'},anthropic:{signature:'signed-fixture'}}},{type:'text',text:'Answer',providerOptions:{openai:{itemId:'msg_fixture'}}}]}],[],1024)
}

// Compaction requests have no tools and ask the installed SDK for temperature 0.
for(const [provider,models] of [['openai',['gpt-4o','gpt-5','gpt-5-chat-latest','gpt-5.6-chat-latest','o3']],['custom-openai',['custom-model','gpt-4o-search-preview','gpt-4o-mini-search-preview','gpt-5']],['anthropic',['claude-opus-5','claude-opus-4-8','claude-opus-4-7','claude-fable-5','claude-sonnet-5','claude-opus-4-6','claude-sonnet-4-6','claude-sonnet-4-5','claude-opus-4-5','claude-haiku-4-5','claude-opus-4-1','claude-sonnet-4-0','claude-opus-4-0','claude-3-haiku','claude-3-5-sonnet','claude-2.1','claude-instant-1','claude-future','custom-model']]])for(const model of models)await capture(provider,model,simple,[],1024,0)
