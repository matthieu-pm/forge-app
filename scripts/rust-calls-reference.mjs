import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as c from '../apps/forge/src/lib/calls.ts'
import { selectedCallProviders } from '../packages/environment/service-config.ts'
const { z } = createRequire(new URL('../apps/forge/package.json', import.meta.url))('zod')
const id = '00000000-0000-4000-8000-000000000001'
const schemas = { provider:c.meetingProviderSchema, entry:c.transcriptEntrySchema, recap:c.recapSchema,
  read:c.callIdSchema, import:c.importCallSchema, connect:c.connectCallSchema, note:c.noteInputSchema,
  retention:c.retentionInputSchema, list:z.object({teamId:z.string().uuid().optional()}),
  action:c.callIdSchema.extend({actionId:z.string().uuid(),completed:z.boolean()}),
  disconnect:z.object({id:z.string().uuid()}) }
const cases=[]
const add=(kind,input)=>{const r=schemas[kind].safeParse(input); cases.push({kind,input,valid:r.success,...(r.success?{output:r.data}:{})})}
for(const kind of Object.keys(schemas))for(const value of [null,{},[],false,''])add(kind,value)
const imported={teamId:id,title:' Review ',startedAt:'2026-11-12T10:30:00.000Z',text:' Alex: Hello ',consentConfirmed:true}
const note={callId:id,body:' Note ',kind:'follow-up'}
const recap={summary:'Summary',decisions:['Decision'],actions:[{title:'Action',owner:'Alex'}]}
for(const [kind,base] of Object.entries({import:imported,note,recap,connect:{provider:'google',teamId:id,consentConfirmed:true},read:{callId:id},list:{teamId:id},action:{callId:id,actionId:id,completed:true},retention:{days:30},disconnect:{id}})){
 add(kind,base);add(kind,{...base,unknown:'stripped'})
 for(const key of Object.keys(base)){const input={...base};delete input[key];add(kind,input)}
}
for(const provider of ['google','teams','zoom','upload','Google','',null]){add('provider',provider);add('connect',{provider,teamId:id,consentConfirmed:true})}
for(const [key,values] of Object.entries({teamId:['bad',id.toUpperCase(),null],title:['',' \ufeff\u00a0','\ufeffTitle\u00a0','x'.repeat(240),'x'.repeat(241),'🙂'.repeat(240),'🙂'.repeat(241)],text:['','   ','x'.repeat(250000),'x'.repeat(250001)],startedAt:['2026-11-12T10:30Z','2026-11-12T10:30:00Z','2026-11-12T10:30:00.123456Z','2026-11-12T10:30:00+01:00','2026-02-29T00:00:00Z','2028-02-29T00:00:00Z','0000-01-01T00:00:00Z'],consentConfirmed:[false,'true',1,null]}))for(const value of values)add('import',{...imported,[key]:value})
for(const days of [7,30,90,365,0,1,31,365.5,'30',null])add('retention',{days})
for(const [key,values] of Object.entries({body:['',' ','\ufeffNote\u00a0','x'.repeat(10000),'x'.repeat(10001)],kind:['note','follow-up','other',null]}))for(const value of values)add('note',{...note,[key]:value})
for(const [key,values] of Object.entries({speaker:['','x'.repeat(200),'x'.repeat(201),'🙂'.repeat(200)],text:['','x'.repeat(20000),'x'.repeat(20001)],seconds:[0,-1,1.5,'1',null]}))for(const value of values)add('entry',{speaker:'Alex',text:'Text',seconds:0,[key]:value,unknown:1})
for(const [key,values] of Object.entries({summary:['','x'.repeat(8000),'x'.repeat(8001)],decisions:[[],Array(50).fill('x'),Array(51).fill('x'),['x'.repeat(2001)]],actions:[[],Array(50).fill({title:'x',owner:''}),Array(51).fill({title:'x',owner:''}),[{title:'',owner:''}],[{title:' ',owner:'',extra:1}],[{title:'x'.repeat(241),owner:''}],[{title:'x',owner:'x'.repeat(201)}]]}))for(const value of values)add('recap',{...recap,[key]:value})
const texts=['',' \r\n ','WEBVTT','WEBVTT\n\n','WEBVTTx','\ufeffAlex: Hello\r\nSam: Good','Alex: Decision: keep scope small.\nSam: Agreed.','  Alex: Kept whitespace\n unlabelled ','Alex:No separator','--> malformed\nAlex: Hi','00:01:02.000 --> 00:01:03.000\n','01:02:03,123 --> 01:02:04,000\n<v Alex>Hello\nworld.</v>','WEBVTT\n\n1\n00:01.999 --> 00:02.000\nAlex: &amp;lt;b&amp;gt; A &lt;tag&gt;\n\n2\n00:03.000 --> 00:04.000\n<i>Sam</i>: Hi', 'WEBVTT\n\n00:00.000 --> 00:01.000\n <v Alex>  </v>']
for(const speaker of ['A','🙂'.repeat(50),'🙂'.repeat(51),'x'.repeat(100),'x'.repeat(101),'A\u2028B',''])for(const separator of [' ', '\t','\ufeff','\u0085','\u2028']){
 texts.push(`${speaker}:${separator}First\u2028Second`)
 texts.push(`00:00:12.900 --> 00:00:15.000\n${speaker}:${separator}First\u2028Second`)
}
for(const prefix of ['','WEBVTT\n\n','\ufeffWEBVTT\r\n\r\n'])for(const body of ['<v Alex>Decision: one.</v>','<v Alex><b>A</b> &amp; &lt; &gt;</v>','<v  Alex >Hi</v>','Sam: One\nTwo','<script>text</script>','  ','<br>','&amp;amp; &quot; &#39;'])texts.push(`${prefix}12:34:56.123 --> 12:35:00.000\n${body}`)
const providers=[]
for(const selected of [undefined,'','google',' teams,zoom, google,teams ','unknown,google'])for(const enabled of [undefined,'true','false','FALSE']){
 const input={FORGE_GOOGLE_MEET_CLIENT_ID:'id',FORGE_MICROSOFT_TEAMS_CLIENT_SECRET:'secret',...(selected===undefined?{}:{FORGE_CALLS_PROVIDERS:selected}),...(enabled===undefined?{}:{FORGE_CALLS_ENABLED:enabled})}
 providers.push({input,output:selectedCallProviders(input)})
}
const fixture={cases,transcripts:texts.map(input=>({input,output:c.parseTranscript(input)})),labels:[0,1,59,60,61,3599,3600,3661,61.9].map(input=>({input,output:c.timestampLabel(input)})),providers}
const output=JSON.stringify(fixture,null,2)+'\n'
const path=new URL('../rust/crates/forge-core/data/calls-reference.json',import.meta.url)
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error('Calls reference changed')}else writeFileSync(path,output)
console.log(`Calls reference: ${cases.length} contracts, ${texts.length} transcripts, ${providers.length} provider selections`)
