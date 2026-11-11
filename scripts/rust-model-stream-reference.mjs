import {createOpenAI} from '../services/agent-runtime/node_modules/@ai-sdk/openai/dist/index.js'
import {createAnthropic} from '../services/agent-runtime/node_modules/@ai-sdk/anthropic/dist/index.js'
const input={slug:'forge',emoji:'😀'}
const argumentsText=JSON.stringify(input)
const calls=(mode)=>mode==='parallel'?2:mode.includes('tool')||mode==='mixed'?1:0
const hasText=(mode)=>['text','mixed','reasoning','length'].includes(mode)
function frames(protocol,mode){
 const output=[];const push=(type,fields={})=>output.push({type,...fields})
 if(protocol==='responses'){
  push('response.created',{response:{id:'resp_fixture',created_at:1000,model:'gpt-5.6-luna'}})
  let index=0
  if(mode==='reasoning'){
   const item={type:'reasoning',id:'rs_fixture',encrypted_content:null}
   push('response.output_item.added',{output_index:index,item})
   push('response.reasoning_summary_part.added',{item_id:item.id,output_index:index,summary_index:0,part:{type:'summary_text',text:''}})
   push('response.reasoning_summary_text.delta',{item_id:item.id,output_index:index,summary_index:0,delta:'Thinking.'})
   push('response.reasoning_summary_part.done',{item_id:item.id,output_index:index,summary_index:0,part:{type:'summary_text',text:'Thinking.'}})
   push('response.output_item.done',{output_index:index++,item})
  }
  if(hasText(mode)){
   const item={type:'message',id:'msg_fixture',phase:'final_answer'}
   push('response.output_item.added',{output_index:index,item})
   for(const delta of ['Hello ','hé😀'])push('response.output_text.delta',{item_id:item.id,output_index:index,content_index:0,delta})
   push('response.output_item.done',{output_index:index++,item})
  }
  for(let i=0;i<calls(mode);i++){
   const args=mode==='empty_tool'?'{}':argumentsText
   const item={type:'function_call',id:`fc_${i}`,call_id:`call_${i}`,name:mode==='empty_tool'?'describe_workspace':'get_team',arguments:''}
   push('response.output_item.added',{output_index:index,item})
   for(const delta of [args.slice(0,5),args.slice(5)])push('response.function_call_arguments.delta',{output_index:index,item_id:item.id,delta})
   push('response.output_item.done',{output_index:index++,item:{...item,arguments:args,status:'completed'}})
  }
  push(mode==='length'?'response.incomplete':'response.completed',{response:{id:'resp_fixture',incomplete_details:mode==='length'?{reason:'max_output_tokens'}:null,usage:{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:2},output_tokens_details:{reasoning_tokens:3}}}})
 }else if(protocol==='chat'){
  const chunk=(delta,finish_reason=null)=>output.push({id:'chat_fixture',model:'compatible',created:1000,choices:[{index:0,delta,finish_reason}]})
  if(hasText(mode))for(const content of ['Hello ','hé😀'])chunk({content})
  for(let i=0;i<calls(mode);i++){
   const args=mode==='empty_tool'?'{}':argumentsText
   chunk({tool_calls:[{index:i,id:`call_${i}`,type:'function',function:{name:mode==='empty_tool'?'describe_workspace':'get_team',arguments:args.slice(0,5)}}]})
   chunk({tool_calls:[{index:i,function:{arguments:args.slice(5)}}]})
  }
  chunk({},mode==='length'?'length':calls(mode)?'tool_calls':'stop')
  output.push({id:'chat_fixture',choices:[],usage:{prompt_tokens:10,completion_tokens:5,prompt_tokens_details:{cached_tokens:2},completion_tokens_details:{reasoning_tokens:3}}})
  output.push('[DONE]')
 }else{
  push('message_start',{message:{id:'msg_fixture',model:'claude-sonnet-4-5',role:'assistant',content:[],usage:{input_tokens:10,cache_read_input_tokens:2,cache_creation_input_tokens:1}}})
  let index=0
  if(mode==='reasoning'){
   push('content_block_start',{index,content_block:{type:'thinking',thinking:''}})
   push('content_block_delta',{index,delta:{type:'thinking_delta',thinking:'Thinking.'}})
   push('content_block_delta',{index,delta:{type:'signature_delta',signature:'signed-fixture'}})
   push('content_block_stop',{index:index++})
  }
  if(hasText(mode)){
   push('content_block_start',{index,content_block:{type:'text',text:''}})
   for(const text of ['Hello ','hé😀'])push('content_block_delta',{index,delta:{type:'text_delta',text}})
   push('content_block_stop',{index:index++})
  }
  for(let i=0;i<calls(mode);i++){
   push('content_block_start',{index,content_block:{type:'tool_use',id:`call_${i}`,name:mode==='empty_tool'?'describe_workspace':'get_team',input:{}}})
   if(mode!=='empty_tool')for(const partial_json of [argumentsText.slice(0,5),argumentsText.slice(5)])push('content_block_delta',{index,delta:{type:'input_json_delta',partial_json}})
   push('content_block_stop',{index:index++})
  }
  push('message_delta',{delta:{stop_reason:mode==='length'?'max_tokens':calls(mode)?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:5,output_tokens_details:{thinking_tokens:3}}})
  push('message_stop')
 }
 return output
}
export const modelStreams=[]
async function capture(protocol,mode,events){
 const wire=events.map(v=>`data: ${typeof v==='string'?v:JSON.stringify(v)}\r\n\r\n`).join('')
 const options={baseURL:'https://forge.test/api/agent/runtime/model',apiKey:'public-fixture',fetch:async()=>new Response(wire,{headers:{'content-type':'text/event-stream'}})}
 const model=protocol==='anthropic'?createAnthropic(options)('claude-sonnet-4-5'):protocol==='responses'?createOpenAI(options)('gpt-5.6-luna'):createOpenAI(options).chat('compatible')
 let failed=false;let text='',reasoning='',finish=null,usage=null;const tools=[]
 try{
  const result=await model.doStream({prompt:[{role:'user',content:[{type:'text',text:'Hello'}]}],maxOutputTokens:1024})
  for await(const part of result.stream){
   if(part.type==='text-delta')text+=part.delta
   if(part.type==='reasoning-delta')reasoning+=part.delta
   if(part.type==='tool-call')tools.push({id:part.toolCallId,name:part.toolName,input:JSON.parse(part.input)})
   if(part.type==='error')failed=true
   if(part.type==='finish'){
    finish=part.finishReason.unified;const u=part.usage
    usage={inputTokens:u.inputTokens.total??null,outputTokens:u.outputTokens.total??null,cacheReadTokens:u.inputTokens.cacheRead??null,cacheWriteTokens:u.inputTokens.cacheWrite??null,reasoningTokens:u.outputTokens.reasoning??null}
   }
  }
 }catch{failed=true}
 modelStreams.push({protocol,mode,events,expected:{text,reasoning,tools,finish,usage},failed})
}
for(const protocol of ['responses','chat','anthropic']){
 for(const mode of ['text','tool','mixed','parallel','empty_tool','length',...protocol==='chat'?[]:['reasoning']])await capture(protocol,mode,frames(protocol,mode))
}
const absent=frames('chat','text');absent.splice(-2,1);await capture('chat','unknown-usage',absent)
const cached=frames('anthropic','text');cached.at(-2).usage.iterations=[{type:'compaction',input_tokens:20,output_tokens:4},{type:'message',input_tokens:10,output_tokens:5},{type:'advisor_message',input_tokens:100,output_tokens:200}];await capture('anthropic','iterations',cached)
const fallback=structuredClone(cached);fallback.at(-2).usage.iterations.push({type:'fallback_message',model:'claude-sonnet-4-5',input_tokens:10,output_tokens:5});await capture('anthropic','fallback-usage',fallback)
