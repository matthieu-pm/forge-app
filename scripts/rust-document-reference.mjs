import {documentBodySchema,documentFieldsSchema,documentSourceSchema,documentCommandSchema,emptyDocumentBody} from '../apps/forge/src/lib/document-contract.ts'
import {documentPlainText,defaultDocumentIcon} from '../apps/forge/src/lib/team-documents.ts'
import {matchesReviewedLegacyDocument,retainCanonicalDocumentCopies} from '../apps/forge/src/lib/document-copy-recovery.ts'
import {teamContentFeatureEnabled} from '../apps/forge/src/application/team-content-feature-policy.ts'
export const documentContracts={cases:[],stress:[],features:[],matches:[],retained:[]}
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const schemas={body:documentBodySchema,fields:documentFieldsSchema,source:documentSourceSchema,command:documentCommandSchema}
function add(kind,input){try{const expected=schemas[kind].parse(input);documentContracts.cases.push({kind,input,valid:true,expected,...(kind==='body'?{plain:documentPlainText(expected)}:{})})}catch{documentContracts.cases.push({kind,input,valid:false})}}
const text=s=>({type:'text',text:s})
const paragraph=s=>({type:'paragraph',content:[text(s)]})
const doc=(...content)=>({type:'doc',content})
const fields={title:' Review ',body:doc(paragraph('Hello')),icon:defaultDocumentIcon}
for(const v of [emptyDocumentBody(),{type:'doc'},null,[],doc(paragraph('Hello'),{type:'horizontalRule'}),{type:'doc',attrs:{},content:[]},{type:'doc',unknown:true},doc(text('bad')),doc({type:'script'}),doc({type:'paragraph',marks:[]}),doc({type:'paragraph',text:''}),doc({type:'paragraph',content:[text('')]}),doc({type:'paragraph',content:[{...text('x'),attrs:null}]})])add('body',v)
for(const type of ['heading','orderedList','taskItem','codeBlock','details','callout','diagram','analyticsChart','image','paragraph','hardBreak']){
  const attrs={heading:{level:2},orderedList:{start:2,type:null},taskItem:{checked:false},codeBlock:{language:'rust'},details:{open:true},callout:{icon:defaultDocumentIcon},diagram:{source:'graph TD; A --> B'},analyticsChart:{chart:{title:'Users',kind:'line',unit:'percent',series:['Active'],points:[{label:'Mon',values:[50]}],source:{provider:'PostHog',account:'Forge',product:'App',period:'Week',simulated:true},caption:'Example',ignored:true}},image:{src:'data:image/png;base64,AQ==',width:2.5,alt:null},paragraph:{},hardBreak:{}}[type]
  const wrap=node=>type==='taskItem'?doc({type:'taskList',content:[node]}):type==='hardBreak'?doc({type:'paragraph',content:[node]}):doc(node)
  const node={type,attrs,...(type==='details'?{content:[{type:'detailsSummary',content:[text('Summary')]},{type:'detailsContent',content:[paragraph('Body')]}]}:{})}
  for(const change of [{},{attrs:undefined},{attrs:null},{attrs:{...attrs,unknown:true}},{content:[]}])add('body',JSON.parse(JSON.stringify(wrap({...node,...change}))))
}
for(const href of ['https://example.test','mailto:a@example.test','javascript:alert(1)','data:text/html,x','/relative','https://user:pass@example.test','https://example.test/\nunsafe'])add('body',doc({type:'paragraph',content:[{...text('Link'),marks:[{type:'link',attrs:{href,target:'_self',class:'extra',rel:null}}]}]}))
for(const attrs of [undefined,null,false,{},''])add('body',JSON.parse(JSON.stringify(doc({type:'paragraph',content:[{...text('Style'),marks:[{type:'bold',attrs}]}]}))))
for(const src of ['https://example.test/a.png','HTTP://example.test/a.png','data:image/svg+xml;base64,AA','data:image/gif;base64,AA','http:foo','file:///tmp/image.png'])add('body',doc({type:'image',attrs:{src}}))
for(const v of [fields,{...fields,title:''},{...fields,title:'😀'.repeat(200)},{...fields,sectionId:null},{...fields,sectionId:uuid(1)},{...fields,icon:{...defaultDocumentIcon,extra:true}},{...fields,extra:true}])add('fields',v)
for(const kind of ['workspace','team','project','issue','loop'])for(const id of [undefined,uuid(1),null,'legacy'])add('source',JSON.parse(JSON.stringify({kind,id})))
for(const action of ['create','save','restore','delete','share']){
  const command={action,id:uuid(1),...(action==='create'?{source:{kind:'workspace'},fields}:{expectedRevision:0}),...(['save'].includes(action)?{fields}:{}),...(action==='restore'?{revision:1}:{}),...(action==='share'?{shared:true}:{})}
  for(const change of [{},{extra:true},{id:'invalid'},...(action==='create'?[{legacyImport:true},{legacyImport:false}]:[{expectedRevision:-1},{expectedRevision:1.5},{expectedRevision:null}])])add('command',{...command,...change})
}
for(const depth of [1,63,64,65]){let body={type:'paragraph'};for(let i=1;i<depth;i++)body={type:'blockquote',content:[body]};body=doc(body);documentContracts.stress.push({kind:'depth',count:depth,valid:documentBodySchema.safeParse(body).success})}
for(const count of [9999,10000])documentContracts.stress.push({kind:'nodes',count,valid:documentBodySchema.safeParse(doc(...Array.from({length:count},()=>({type:'paragraph'})))).success})
const overhead=JSON.stringify(doc(paragraph(''))).length
for(const count of [1_000_000-overhead,1_000_001-overhead])documentContracts.stress.push({kind:'size',count,valid:documentBodySchema.safeParse(doc(paragraph('a'.repeat(count)))).success})
for(const env of [{},{NODE_ENV:'production'},{NODE_ENV:'test'},{VERCEL_ENV:''},{VERCEL_ENV:'preview'},{FORGE_ENVIRONMENT:'development'},{FORGE_ENVIRONMENT:''},{FORGE_SERVICE_ENVIRONMENT:'preview'},{FORGE_ENVIRONMENT:'production',FORGE_SHARED_DOCUMENTS_ENABLED:'true'},{FORGE_SHARED_DOCUMENTS_ENABLED:'false'},{FORGE_SHARED_DOCUMENTS_ENABLED:'TRUE'}])documentContracts.features.push({env,expected:teamContentFeatureEnabled('FORGE_SHARED_DOCUMENTS_ENABLED',env)})
const reviewed=documentFieldsSchema.parse(fields)
const copy={id:uuid(1),kind:'document',title:'Review',body:fields.body,content:'Hello',sectionId:null,icon:defaultDocumentIcon}
for(const kind of ['team','project'])for(const change of [{},{body:null},{body:undefined},{content:'Changed'},{title:'Changed'},{url:'https://example.test'},{icon:null},{sectionId:uuid(2)},{body:{type:'script'}},{kind:'link'}]){const resource=JSON.parse(JSON.stringify({...copy,...change}));documentContracts.matches.push({kind,resource,fields:reviewed,expected:matchesReviewedLegacyDocument(resource,reviewed,kind)})}
const state=resources=>JSON.stringify({favorite:true,sections:[],resources,loops:[]})
for(const [value,previous] of [[state([copy]),null],[state([{...copy,title:'New draft'}]),state([copy])],[null,state([copy])],[state([]),state([copy])],[state([{id:uuid(2),kind:'link',url:'https://example.test'}]),null],[null,null],[JSON.stringify({resources:[copy],retainedDocumentDrafts:[copy,{raw:'unsafe'}]}),state([copy])],['{}',null],[state([]),'[]']]){
  const item={value,previous,ids:[uuid(1)]};try{item.expected=retainCanonicalDocumentCopies(value,previous,new Set(item.ids));item.valid=true}catch{item.valid=false}documentContracts.retained.push(item)
}

{const reordered=Object.fromEntries(Object.entries(copy).reverse());const value=state([reordered]),previous=state([copy]);documentContracts.retained.push({value,previous,ids:[uuid(1)],valid:true,expected:retainCanonicalDocumentCopies(value,previous,new Set([uuid(1)]))})}
