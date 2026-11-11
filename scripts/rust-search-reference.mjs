// Provider search wire fixtures from the installed SDK; fetch is in-memory only.
import {readFileSync,writeFileSync} from 'node:fs'
import {normalizeProviderToolHistory} from '../services/agent-runtime/node_modules/eve/dist/src/harness/provider-tool-history.js'
import {createOpenAI} from '../services/agent-runtime/node_modules/@ai-sdk/openai/dist/index.js'
import {createAnthropic} from '../services/agent-runtime/node_modules/@ai-sdk/anthropic/dist/index.js'
const simple=[{role:'system',content:'You are Forge.'},{role:'user',content:[{type:'text',text:'Search for Forge.'}]}]
const tool=provider=>({type:'provider',id:provider.includes('anthropic')?'anthropic.web_search_20250305':'openai.web_search',name:'web_search',args:{}})
const result=[{type:'web_search_result',url:'https://example.com',title:'Example',pageAge:null,encryptedContent:'fixture-encrypted-content'}]
const history=(output,input={query:'Forge'},options)=>[...simple,{role:'assistant',content:[{type:'tool-call',toolCallId:'search_fixture',toolName:'web_search',input,providerExecuted:true,...options?{providerOptions:options}:{}},{type:'tool-result',toolCallId:'search_fixture',toolName:'web_search',output},{type:'text',text:'Found this.'}]}]
const cited=history({type:'json',value:result});cited.at(-1).content.at(-1).providerOptions={anthropic:{citations:[{type:'web_search_result_location',url:'https://example.com',title:'Example',cited_text:'Found this.',encrypted_index:'fixture-opaque-citation'}]}}
const requests=[]
for(const provider of ['openai','anthropic','custom-anthropic','custom-openai']) {
 const modelId=provider.includes('anthropic')?'claude-sonnet-4-5':provider==='openai'?'gpt-5.6-luna':'compatible'
 for(const prompt of [simple,cited,history({type:'json',value:result}),history({type:'error-json',value:{type:'web_search_tool_result_error',errorCode:'unavailable'}}),history({type:'json',value:[]},{query:'Empty'}),history({type:'json',value:result},{query:'Forge'},{openai:{itemId:'search_item_fixture'}})]) {
  let request=null,failed=false,warnings=[]
  const config={baseURL:'https://fixture.invalid/v1',apiKey:'public-fixture-key',fetch:async(url,init)=>{request={path:new URL(url).pathname,body:JSON.parse(init.body)};return new Response('',{headers:{'content-type':'text/event-stream'}})}}
  const model=provider.includes('anthropic')?createAnthropic(config)(modelId):provider==='openai'?createOpenAI(config)(modelId):createOpenAI(config).chat(modelId)
  const input={provider,modelId,prompt,tools:[tool(provider)],maxOutputTokens:1024}
  try{const response=await model.doStream({...input,toolChoice:{type:'auto'}});for await(const part of response.stream)if(part.type==='stream-start')warnings=part.warnings}catch{failed=true}
  requests.push({input,request,failed,warnings})
 }
}
const streams=[]
function frames(protocol,variant) {
 const events=[];const push=(type,data={})=>events.push({type,...data})
 if(protocol==='responses') {
  push('response.created',{response:{id:'response_fixture',created_at:1000,model:'gpt-5.6-luna'}})
  let action=variant==='empty'?undefined:variant==='open-missing'?{type:'open_page'}:variant==='find-null'?{type:'find_in_page',url:null,pattern:null}:variant==='open'?{type:'open_page',url:'https://example.com'}:variant==='find'?{type:'find_in_page',url:'https://example.com',pattern:'Forge'}:{type:'search',query:'Forge',queries:['Forge','Forge Rust'],sources:[{type:'url',url:'https://example.com'},{type:'api',name:'Fixture API'}]}
  const item={type:'web_search_call',id:'search_fixture',status:'in_progress'}
  push('response.output_item.added',{output_index:0,item})
  push('response.output_item.done',{output_index:0,item:{...item,status:'completed',...action?{action}:{}}})
  if(variant!=='only') {
   push('response.output_item.added',{output_index:1,item:{type:'message',id:'message_fixture'}})
   push('response.output_text.delta',{output_index:1,item_id:'message_fixture',content_index:0,delta:'Found this.'})
   if(variant==='citations')push('response.output_text.annotation.added',{item_id:'message_fixture',output_index:1,content_index:0,annotation_index:0,annotation:{type:'url_citation',url:'https://example.com',title:'Example',start_index:0,end_index:11}})
   push('response.output_item.done',{output_index:1,item:{type:'message',id:'message_fixture'}})
  }
  push('response.completed',{response:{id:'response_fixture',incomplete_details:null,usage:{input_tokens:10,output_tokens:5}}})
 }else {
  push('message_start',{message:{id:'message_fixture',model:'claude-sonnet-4-5',role:'assistant',content:[],usage:{input_tokens:10,output_tokens:0}}})
  push('content_block_start',{index:0,content_block:{type:'server_tool_use',id:'search_fixture',name:'web_search',input:variant==='inline'?{query:'Forge'}:{}}})
  if(variant!=='inline') push('content_block_delta',{index:0,delta:{type:'input_json_delta',partial_json:'{"query":"Forge"}'}})
  push('content_block_stop',{index:0})
  const content=variant==='error'?{type:'web_search_tool_result_error',error_code:'too_many_requests'}:variant==='empty'?[]:[{type:'web_search_result',url:'https://example.com',title:'Example',encrypted_content:'fixture-encrypted-content',page_age:'Today'}]
  push('content_block_start',{index:1,content_block:{type:'web_search_tool_result',tool_use_id:'search_fixture',content}})
  push('content_block_stop',{index:1})
  if(variant!=='only') {
   push('content_block_start',{index:2,content_block:{type:'text',text:''}})
   push('content_block_delta',{index:2,delta:{type:'text_delta',text:'Found this.'}})
   if(variant==='citations')push('content_block_delta',{index:2,delta:{type:'citations_delta',citation:{type:'web_search_result_location',url:'https://example.com',title:'Example',cited_text:'Found this.',encrypted_index:'fixture-opaque-citation'}}})
   push('content_block_stop',{index:2})
  }
  push('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}})
  push('message_stop')
 }
 return events
}
for(const protocol of ['responses','anthropic']) for(const variant of protocol==='responses'?['search','empty','open','find','open-missing','find-null','only','citations']:['search','empty','error','inline','only','citations']) {
 const events=frames(protocol,variant), wire=events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')
 const options={baseURL:'https://fixture.invalid/v1',apiKey:'public-fixture-key',fetch:async()=>new Response(wire,{headers:{'content-type':'text/event-stream'}})}
 const model=protocol==='responses'?createOpenAI(options)('gpt-5.6-luna'):createAnthropic(options)('claude-sonnet-4-5')
 let failed=false,finish=null,usage=null;const parts=[],citations=[]
 try {
  const response=await model.doStream({prompt:simple,tools:[tool(protocol==='responses'?'openai':'anthropic')],toolChoice:{type:'auto'},maxOutputTokens:1024})
  for await(const p of response.stream) {
   if(p.type==='error') failed=true
   if(p.type==='tool-call') parts.push({type:'tool-call',toolCallId:p.toolCallId,toolName:p.toolName,input:JSON.parse(p.input),providerExecuted:p.providerExecuted})
   if(p.type==='tool-result') parts.push({type:'tool-result',toolCallId:p.toolCallId,toolName:p.toolName,output:{type:p.isError?'error-json':'json',value:p.result}})
   if(p.type==='source' && (protocol==='responses'||p.providerMetadata?.anthropic?.citedText!==undefined)) citations.push({url:p.url,title:p.title,...p.providerMetadata?.anthropic?.citedText!==undefined?{citedText:p.providerMetadata.anthropic.citedText}:{}})
   if(p.type==='text-delta') parts.push({type:'text',text:p.delta})
   if(p.type==='finish') {finish=p.finishReason.unified;const u=p.usage;usage={inputTokens:u.inputTokens.total??null,outputTokens:u.outputTokens.total??null,cacheReadTokens:u.inputTokens.cacheRead??null,cacheWriteTokens:u.inputTokens.cacheWrite??null,reasoningTokens:u.outputTokens.reasoning??null}}
  }
 }catch{failed=true}
 streams.push({protocol,variant,events,expected:{parts,finish,usage,citations},failed})
}
const continuations=[]
const pair=streams.find(s=>s.protocol==='responses'&&s.variant==='only').expected.parts
for(const content of [pair,[{type:'text',text:'Checking.'},...pair],[...pair,{type:'text',text:'Answer.'}],[...pair,{type:'text',text:' \ufeff '}],[...pair,{type:'text',text:'Answer.'},...pair.map(p=>({...p,toolCallId:'search_second'}))]]) {
 const expected=normalizeProviderToolHistory({messages:[{role:'assistant',content}],providerExecutedOutcomeIds:new Set(content.filter(p=>p.type==='tool-result').map(p=>p.toolCallId))})
 continuations.push({content,continues:expected.outcomeEndsResponse})
}
const path=new URL('../rust/crates/forge-agent-runtime/data/search-reference.json',import.meta.url)
const text=JSON.stringify({requests,streams,continuations},null,2)+'\n'
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==text)throw Error('Provider search reference changed')}else writeFileSync(path,text)
console.log(`Provider search reference: ${requests.length} requests and ${streams.length} streams and ${continuations.length} continuation cases`)
