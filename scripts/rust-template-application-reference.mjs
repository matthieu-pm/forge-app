import { readFileSync, writeFileSync } from 'node:fs'
import * as schemas from '../apps/forge/src/lib/template-application-contract.ts'
import { emptyTemplate } from '../apps/forge/src/lib/template-contract.ts'
import { formContent, templateDocumentText } from '../apps/forge/src/application/templates/template-forms.ts'
import { commandInputHash } from '../apps/forge/src/application/commands/command-input.ts'
const id = '00000000-0000-4000-8000-000000000001'
const base = {commandKey:id,templateId:id,revision:'a'.repeat(64)}
const cases=[]
const add=(kind,input)=>{const schema=kind==='query'?schemas.templateApplicationQuerySchema:schemas.applyTemplateSchema;const result=schema.safeParse(input);cases.push({kind,input,valid:result.success,...(result.success?{output:result.data}:{})})}
for(const input of [null,{},[],false,'text',{slug:'team',kind:'issue',extra:1},{slug:'team',kind:'project'},{slug:''},{slug:'x'.repeat(101)},{kind:'document'},{kind:null}])add('query',input)
for(const input of [base,{...base,extra:1},{...base,teamId:id,title:'  Custom title  ',triage:true},{...base,title:'\ufeffNew title\u00a0'},null,{}])add('apply',input)
for(const [key,values] of Object.entries({commandKey:['not-uuid','',null],templateId:[id.toUpperCase(),'wrong'],revision:['a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'a'.repeat(64)+'\n','a'.repeat(64)+'\r\n'],teamId:[null,'wrong'],triage:[null,0,'true'],title:['',' ','x'.repeat(201),'🙂'.repeat(100),'🙂'.repeat(101)],answers:[{},null,[],{a:true,b:false,c:0,d:1e21,e:''},{a:null},{a:[]},{a:{}},{['a'.repeat(201)]:'x'},{a:'x'.repeat(10000)},{a:'x'.repeat(10001)}]}))for(const value of values)add('apply',{...base,[key]:value})
const template={...emptyTemplate('issue',id),name:'Example',title:'Request',content:{type:'doc',extra:'retained for non-form',content:[{type:'paragraph',content:[{type:'text',text:'Existing body'}]}]}}
const forms=[]
const form=(template,answers)=>{try{const output=formContent(template,answers);forms.push({template,answers,valid:true,output,text:templateDocumentText(output)})}catch(error){forms.push({template,answers,valid:false,message:error.message})}}
form(template,{});form(template,{extra:'answer'})
for(const type of ['text','textarea','select','checkbox','date','number'])for(const required of [false,true]){
 const t={...template,issueType:'form',fields:[{id:'field',label:'Answer',type,required,options:['A','B']}]}
 for(const value of [undefined,'',' \ufeff\u00a0','A','Details',true,false,0,-2.5,1e-7,1e21,'2028-02-29','2026-02-29','0000-01-01'])form(t,value===undefined?{}:{field:value})
}
for(const fields of [[{id:'',label:'Missing',type:'text',required:false,options:[]}],[{id:'x',label:'First',type:'text',required:false,options:[]},{id:'x',label:'Second',type:'number',required:false,options:[]}],[]])form({...template,issueType:'form',fields},{})
form({...template,issueType:'form',fields:[]},{extra:'value'})
const all={...template,issueType:'form',fields:['text','textarea','select','checkbox','date','number'].map(type=>({id:type,label:type,type,required:true,options:['A']}))}
form(all,{text:'Hello',textarea:'Details',select:'A',checkbox:true,date:'2026-11-11',number:7})
const texts=[null,{type:'doc'},{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'One'},{type:'hardBreak'},{type:'text',text:'Two'}]},{type:'bulletList',content:[{type:'listItem',content:[{type:'text',text:'Three'}]},{type:'listItem',content:[{type:'text',text:'Four'}]}]}]}]
for(const text of [true,false,0,2,[],[1,null,{nested:1}],{nested:'value'},'Override']){texts.push({type:'doc',text});texts.push({type:'doc',content:[{type:'paragraph',text}]})}
const revisions=[]
for(const updatedAt of ['2030-01-01T00:00:00.123Z','2030-01-01T01:00:00.123+01:00','2099-01-01T00:00:00Z'])revisions.push({payload:template,updatedAt:new Date(updatedAt).toISOString(),output:commandInputHash({payload:template,updatedAt:new Date(updatedAt).toISOString()})})
const output=JSON.stringify({cases,forms,texts:texts.map(input=>({input,output:templateDocumentText(input)})),revisions},null,2)+'\n'
const path=new URL('../rust/crates/forge-core/data/template-application-reference.json',import.meta.url)
if(process.argv.includes('--check')){if(readFileSync(path,'utf8')!==output)throw Error('Template application reference changed')}else writeFileSync(path,output)
console.log(`Template application reference: ${cases.length} contracts, ${forms.length} forms, ${texts.length} text conversions, ${revisions.length} revisions`)
