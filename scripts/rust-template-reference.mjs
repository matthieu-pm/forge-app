import {legacyIntlTimezones} from './rust-intl-timezones.mjs'
import {readFileSync,writeFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import * as t from '../apps/forge/src/lib/template-contract.ts'
import * as r from '../apps/forge/src/lib/recurring-issue-contract.ts'
const {z}=createRequire(new URL('../apps/forge/package.json',import.meta.url))('zod')
const team='00000000-0000-4000-8000-000000000001'
const schemas={payload:t.templatePayloadSchema,document:t.documentSchema,properties:t.propertiesSchema,scope:t.templateScopeSchema,save:t.saveTemplateSchema,delete:t.deleteTemplateSchema,default:t.defaultTemplateSchema,recurring:r.recurringIssuePayloadSchema,recurringScope:t.templateQuerySchema,recurringSave:r.saveRecurringIssueSchema,recurringDelete:t.deleteTemplateSchema.extend({slug:z.string().min(1),updatedAt:z.string().datetime()})}
const base={...t.emptyTemplate('issue',team),name:' Bug report '}
const recurring={...r.emptyRecurringIssue(team,'Europe/Paris',new Date('2030-01-01T23:30:00Z')),title:' Weekly review '}
const cases=[]
const add=(kind,input)=>{const result=schemas[kind].safeParse(input);cases.push({kind,input,valid:result.success,...(result.success?{output:result.data}:{})})}
for(const kind of Object.keys(schemas))for(const input of [null,{},[],false,'text'])add(kind,input)
for(const kind of ['issue','project','document'])add('payload',{...base,kind,extra:'discard'})
for(const [key,values] of Object.entries({name:['',' ','\ufeffNew name\u00a0','x'.repeat(200),'x'.repeat(201),'🙂'.repeat(100),'🙂'.repeat(101)],kind:['form',''],icon:[null,{}, {kind:'emoji',value:'🙂',color:'#ABCDEF',extra:true},{kind:'icon',value:'x',color:'#abcdef\n'},{kind:'icon',value:'x',color:'#abcdef\r\n'}],description:['x'.repeat(2001)],title:['x'.repeat(201)],summary:['x'.repeat(2001)],visibility:[null,team,''],issueType:['standard','form','other'],fields:[[{id:'f',label:' Label ',type:'select',required:true,options:['a'],extra:true}],[{id:'f',label:' ',type:'text',required:false,options:[]}]],milestones:[[{id:'m',title:' Milestone ',content:null}]],issues:[[{id:'i',title:' Child ',content:null,properties:t.emptyProperties(team)}]],subIssues:[[{id:'s',title:'',content:null,properties:t.emptyProperties(team)}]]}))for(const value of values)add('payload',{...base,[key]:value})
for(const [key,values] of Object.entries({teamIds:[[],[team],['wrong'],Array(101).fill(team)],status:['x'.repeat(80),'x'.repeat(81)],estimate:[null,'','x'.repeat(31)],priority:['High','high'],assignee:[null,'',3],lead:[null,'person'],members:[[],['person'],Array(101).fill('x')],project:[null,'x'.repeat(201)],initiatives:[['x'.repeat(201)]],labels:[Array(101).fill('a')],dependencies:[[{direction:'blocking',name:' Need ',unknown:true}],[{direction:'blockedBy',name:' '}]]}))for(const value of values)add('properties',{...t.emptyProperties(team),[key]:value,extra:true})
const nodes=[null,[],{}, {type:'script'}, {type:'text',text:''},{type:'text',text:'Hello',extra:'retain'}, {type:'paragraph',attrs:[]},{type:'heading',attrs:{level:99,extra:true}}, {type:'diagram',attrs:{source:'graph TD'}}, {type:'diagram',attrs:{}}, {type:'callout',attrs:{icon:base.icon}},{type:'analyticsChart',attrs:{chart:{}}}]
for(const src of ['https://','httpſ://example.test/image','HTTP://example.test/image','data:image/png;base64,','data:image/svg+xml;base64,AA','javascript:alert(1)',' https://example.test'])nodes.push({type:'image',attrs:{src}})
for(const src of ['data:teſt/plain;base64,QQ==','data:text/plain;base64,QQ==','data:;base64,','data:text/plain;base64,QQ==\n','data:text/plain;base64,QQ==\r\n','https://example.test/a'])nodes.push({type:'attachment',attrs:{src,name:'file',mime:'text/plain'}})
for(const href of ['mailto:','https://','javascript:alert(1)',' HTTPS://example.test'])nodes.push({type:'text',text:'Link',marks:[{type:'link',attrs:{href}}]})
nodes.push({type:'text',text:'Text',marks:[{type:'bold',extra:'retain'}]},{type:'paragraph',marks:{}},{type:'paragraph',content:{}})
for(const node of nodes)add('document',{type:'doc',content:[node],extra:'retained'})
add('document',null)
for(const depth of [63,64,65]){let node={type:'paragraph'};for(let i=0;i<depth;i++)node={type:'blockquote',content:[node]};add('document',{type:'doc',content:[node]})}
for(const count of [9999,10000])add('document',{type:'doc',content:Array(count).fill({type:'paragraph'})})
for(const [key,values] of Object.entries({firstDue:['2028-02-29','0000-01-01','2026-02-29','2026-04-31','2026-1-2','2030-12-31'],interval:[0,1,100,101,1.5],unit:['day','week','month','year','hour'],title:['  ',' x ','🙂'.repeat(101)]}))for(const value of values)add('recurring',{...recurring,[key]:value,extra:'strip'})
for(const input of [{},{slug:'x'},{slug:''},{slug:'x'.repeat(101)},{slug:null},{extra:1}]){add('scope',input);add('recurringScope',input)}
for(const input of [{},{id:team},{id:'invalid'},{id:team,updatedAt:'not-a-date'},{id:team,updatedAt:'2030-01-01T00:00:00Z'},{id:team,updatedAt:null},{slug:'',extra:1}]){add('save',{slug:'team',payload:base,...input});add('recurringSave',{slug:'team',payload:recurring,...input})}
for(const input of [{id:team},{slug:'x',id:team,updatedAt:'2030-01-01T00:00:00Z'},{slug:'x'.repeat(101),id:team,updatedAt:'2030-01-01T00:00:00.000Z'},{slug:'x',id:team,updatedAt:'2030-01-01T00:00:00+01:00'}]){add('delete',input);add('recurringDelete',input)}
for(const audience of ['members','nonMembers','other'])for(const templateId of [null,team,'bad'])add('default',{slug:'x',audience,templateId,extra:1})
for(const updatedAt of ['2030-01-01T00:00Z','2030-01-01T24:00:00Z','2030-01-01T00:00:60Z','2030-01-01T00:00:00.1Z','0000-01-01T00:00:00Z'])add('recurringSave',{slug:'team',id:team,updatedAt,payload:recurring})
const sizeBase={...base,content:{type:'doc',content:[{type:'diagram',attrs:{source:''}}]}}
const sizeOverhead=JSON.stringify(t.templatePayloadSchema.parse(sizeBase)).length
const sizes=[]
for(const extra of [0,1]){const count=8_000_000-sizeOverhead+extra;const input={payload:{...sizeBase,content:{type:'doc',content:[{type:'diagram',attrs:{source:'語'.repeat(count)}}]}}};sizes.push({count,valid:t.saveTemplateSchema.safeParse(input).success})}
const empty=[]
for(const kind of ['issue','project','document'])for(const id of [undefined,team])empty.push({kind,team:id??null,output:t.emptyTemplate(kind,id)})
const schedules=[]
for(const timezone of ['UTC','Europe/Paris','America/Los_Angeles','Pacific/Kiritimati','Australia/Lord_Howe',...legacyIntlTimezones])for(const now of ['2026-12-31T12:00:00Z','2026-03-29T00:30:00Z','2028-02-27T23:30:00Z'])schedules.push({team,timezone,now,output:r.emptyRecurringIssue(team,timezone,new Date(now))})
const output=JSON.stringify({cases,empty,schedules,sizeBase,sizes},null,2)+'\n'
const path=new URL('../rust/crates/forge-core/data/templates-reference.json',import.meta.url)
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error('Template reference changed')}else writeFileSync(path,output)
console.log(`Template reference: ${cases.length} contract cases, ${empty.length} defaults, ${schedules.length} timezone cases`)
