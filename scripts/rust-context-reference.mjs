// Behavioral fixtures from Forge's pinned EVE harness. Summary calls are mocked
// inside a local copy of the module; this exporter cannot call a model/provider.
import {readFileSync,writeFileSync} from 'node:fs'
import prettier from 'prettier'
import {z} from '../services/agent-runtime/node_modules/eve/dist/src/compiled/zod/index.js'
import {ContextContainer,contextStorage} from '../services/agent-runtime/node_modules/eve/dist/src/context/container.js'
import {TODO_TOOL_DEFINITION,executeTodoTool,getTodoCompactionMessage} from '../services/agent-runtime/node_modules/eve/dist/src/runtime/framework-tools/todo.js'
import * as prompt from '../services/agent-runtime/node_modules/eve/dist/src/harness/compaction-prompt.js'
import {estimateTokens} from '../services/agent-runtime/node_modules/eve/dist/src/harness/token-estimate.js'
function save(path,value){const text=JSON.stringify(value,null,2)+'\n';if(process.argv.includes('--check')){if(readFileSync(new URL(path,import.meta.url),'utf8')!==text)throw Error('Context reference changed: '+path)}else writeFileSync(new URL(path,import.meta.url),text)}
save('../rust/crates/forge-core/data/context-tools.json',[{name:'todo',description:TODO_TOOL_DEFINITION.description,inputSchema:z.toJSONSchema(TODO_TOOL_DEFINITION.inputSchema,{target:'draft-7',io:'input',unrepresentable:'any'})}])
const item={content:'Read the app',priority:'high',status:'pending'}
const inputs=[{},null,[],{extra:true},{todos:[]},{todos:null},{todos:[item]},{todos:[{...item,extra:true}]},{todos:[{...item,content:null}]},{todos:[{...item,priority:'urgent'}]},{todos:[{...item,status:'done'}]},{todos:[{...item,content:'',status:'in_progress'},{...item,priority:'low',status:'completed'},{...item,priority:'medium',status:'cancelled'}]}]
const todo=inputs.map(input=>{const result=TODO_TOOL_DEFINITION.inputSchema.safeParse(input);return{input,valid:result.success,...result.success?{result:result.data}:{}}})
const todos=await contextStorage.run(new ContextContainer(),async()=>[{}, {todos:[item,{...item,content:'Preserve exact paths /workspace/a',status:'in_progress'}]}, {}, {todos:[{...item,status:'completed'},{...item,status:'cancelled',priority:'low'}]}, {todos:[]}].map(input=>({input,output:executeTodoTool(input),preservation:getTodoCompactionMessage()??null})))
const source=await prettier.format(readFileSync(new URL('../services/agent-runtime/node_modules/eve/dist/src/harness/compaction.js',import.meta.url),'utf8'),{parser:'babel'})
const body=source.replace(/^import\s[\s\S]*?;\n/gm,'').replace(/^export\s*\{[\s\S]*?\};?\s*$/gm,'')
const load=new Function('generateText','estimateTokens',...Object.keys(prompt),body+'\nreturn {compactMessages,getInputTokenCount,shouldCompact,selectRecentWindowSize,splitMessagesForCompaction,evaluateThreshold,withResumptionGuard,keepNonToolResultMessages,extractPreviousCheckpoint};')
let calls=[],summarySuffix='';const harness=load(async options=>{calls.push({system:options.system,prompt:options.prompt,temperature:options.temperature});return{text:'Saved summary '+calls.length+'.'+summarySuffix}},estimateTokens,...Object.values(prompt))
const user=content=>({role:'user',content}),assistant=content=>({role:'assistant',content})
const toolPair=(value)=>[assistant([{type:'tool-call',toolCallId:'call_1',toolName:'read_file',input:{filePath:'/workspace/a'}}]),{role:'tool',content:[{type:'tool-result',toolCallId:'call_1',toolName:'read_file',output:{type:'json',value}}]}]
const histories=[[],[user('Small task')],[user('Task'),assistant('Done')],[user('Task'),...toolPair('x'.repeat(14000)),...Array.from({length:12},(_,i)=>i%2?assistant('Answer '+i):user('Question '+i))],[user('x'.repeat(9000)),assistant('y'.repeat(9000)),user('continue this task')],[user(prompt.COMPACTION_CHECKPOINT_MARKER),assistant('previous summary'),user('New task'),...toolPair({content:'old '.repeat(3000)}),assistant('New result')],[user([{type:'file',filename:'diagram.png',mediaType:'image/png',data:{type:'data',data:'aaaa'}}]),assistant([{type:'reasoning',text:'private thought'},{type:'text',text:'Visible answer'}]),user('Continue')]]
histories.push([user(' \ufeffunicode 😀 path /workspace/a\u0085x '),assistant([{type:'text',text:'Visible\n\ttext'},{type:'reasoning',text:'private'},{type:'tool-call',toolName:'read_file',input:{a:'😀'.repeat(1500)}}]),{role:'tool',content:[{type:'tool-result',toolName:'read_file',isError:true,output:{type:'content',value:[{type:'text',text:'  result  '},{type:'file',filename:'report.pdf',mediaType:'application/pdf',data:'aaaa'},{type:'media',mediaType:'image/png'},42,null,{type:'other',value:'x'.repeat(3000)}]}}]},assistant('Tail'),user(prompt.TODO_COMPACTION_PRESERVATION_LABEL+'\n- [ ] [high] unfinished')])
const compaction=[]
for(const messages of histories)for(const threshold of [800,4000])for(const force of [false,true]){
  calls=[];const config={recentWindowSize:10,threshold};const compacted=await harness.compactMessages(messages,{},config,undefined,undefined,undefined,undefined,force)
  compaction.push({messages,config,force,should:harness.shouldCompact(messages,config),estimated:estimateTokens(messages),compacted,calls:[...calls]})
}
summarySuffix='x'.repeat(3500);calls=[]
{const messages=histories[2],config={recentWindowSize:10,threshold:800},force=true;compaction.push({messages,config,force,summarySuffix,should:harness.shouldCompact(messages,config),estimated:estimateTokens(messages),compacted:await harness.compactMessages(messages,{},config,undefined,undefined,undefined,undefined,force),calls:[...calls]})}
const counts=[]
for(const messages of histories)for(const options of [{},{lastKnownInputTokens:42},{lastKnownInputTokens:42,lastKnownPromptMessageCount:0},{lastKnownInputTokens:42,lastKnownPromptMessageCount:2},{lastKnownInputTokens:42,lastKnownPromptMessageCount:999},{lastKnownInputTokens:42,lastKnownPromptMessageCount:-1},{lastKnownInputTokens:42,lastKnownPromptMessageCount:0.5}])counts.push({messages,options,count:harness.getInputTokenCount(messages,options)})
const prompts=histories.flatMap(messages=>[undefined,100,4000].flatMap(transcriptBudgetTokens=>[undefined,' old checkpoint '].map(previousCheckpoint=>{const options={messages,...transcriptBudgetTokens===undefined?{}:{transcriptBudgetTokens},...previousCheckpoint===undefined?{}:{previousCheckpoint}};return{options,result:prompt.createCompactionPrompt(options)}})))
save('../rust/crates/forge-agent-runtime/data/context-reference.json',{todo,todos,counts,prompts,compaction,system:prompt.COMPACTION_PROMPT_ENVELOPE.system})
console.log(`Context reference: ${todo.length} inputs, ${todos.length} state transitions, ${counts.length} estimates, ${prompts.length} prompts, ${compaction.length} compactions`)
