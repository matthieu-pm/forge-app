import {buildImportManifest,validatedImportFiles} from '../apps/forge/src/application/imports/manifest.ts'
import {importIdentitySchema,importRequestSchema,importChoiceSchema,importFileRequestSchema,importCutoverSchema} from '../apps/forge/src/lib/import-execution-contract.ts'
import {blankIssueDraft} from '../apps/forge/src/lib/issue-record-contract.ts'
import {newCustomView} from '../apps/forge/src/lib/custom-views.ts'
import {blankInitiative} from '../apps/forge/src/lib/initiatives.ts'
export const importContracts={requests:[],files:[],manifests:[]}
const uuid='abcdefab-0000-4000-8000-000000000001',now='2026-01-01T00:00:00.000Z',actorId='user',workspaceId='workspace'
const base={workspaceId,sessionId:'session',id:uuid,revision:0}
for(const[kind,schema,input]of [['identity',importIdentitySchema,base],['request',importRequestSchema,base],['choice',importChoiceSchema,{...base,entryId:'entry',choice:'confirm-content',conflictFingerprint:'x'.repeat(64)}],['file',importFileRequestSchema,{...base,entryId:'entry',index:0,fileId:uuid}],['cutover',importCutoverSchema,{...base,action:'cleanup'}]])for(const changes of [{},{extra:true},{revision:-1},{sessionId:''},{id:'legacy'},{ownershipConfirmed:false},{reportFingerprint:'bad'},{conflictFingerprint:'bad'}]){const v={...input,...changes};const r=schema.safeParse(v);importContracts.requests.push({kind,input:v,valid:r.success,...(r.success?{expected:r.data}:{})})}
const file={name:' Original.txt ',data:'data:text/plain;base64,aGVsbG8=',id:'legacy-file',width:50}
for(const change of [{},{name:'path/file'},{name:'bad\nname'},{name:'  '},{data:''},{data:'data:;base64,aGVsbG8='},{data:'data:text/plain;base64,aGVsbG8'},{data:'data:text/plain;base64,AA=='},{data:'data:text/plain;base64,AB=='},{fileId:uuid},{checksum:'0'.repeat(64)},{sizeBytes:10},{width:0},{id:''},{id:'emoji😀'}]){const input=[{...file,...change}];try{importContracts.files.push({input,valid:true,expected:validatedImportFiles(input)})}catch{importContracts.files.push({input,valid:false})}}
const issue={...blankIssueDraft(),id:'legacy-issue',number:1,title:' Original issue ',createdAt:now,updatedAt:now,statusChangedAt:now,creator:'user',suggestedLabel:'',completedAt:null}
const triage={id:'triage',number:1,title:'Triage',description:'Original',priority:'High',dueDate:'',snoozed:false,createdAt:now}
const cycle={id:'cycle',number:1,title:'Cycle',description:'Original',priority:'Low',cycle:'2026-01-01',status:'todo',createdAt:now}
const project={id:'project',name:' Original project ',status:'Backlog',teamIds:[uuid],health:'Update missing',milestones:[{id:'milestone',name:' Ship ',completed:false}],resources:[{id:'document',title:' Project writing ',content:'First\n\nLast'}]}
const initiative={...blankInitiative('user'),id:'initiative',number:1,name:'Initiative',createdAt:now,updatedAt:now,projects:[project]}
const view=newCustomView('issues','user');view.id='view';view.createdAt=now;view.updatedAt=now
const projectView=newCustomView('projects','user');projectView.id='project-view';projectView.createdAt=now;projectView.updatedAt=now
const home={sections:[{id:'section',name:' Links '}],resources:[{id:'document',title:'Writing',content:'Hello\nworld',sectionId:'section'},{id:'link',kind:'link',title:' Reference ',url:'https://example.test',sectionId:'section'}]}
const cases=[
 [['forge:team-issues:v1:'+uuid,JSON.stringify({version:1,issues:[issue]})]],
 [['forge:team-issues:v1:'+uuid,JSON.stringify({version:1,issues:[{...issue,attachments:[file],subIssues:['Child'],milestone:'M'}]})]],
 [['forge:team-issues:v1:'+uuid,JSON.stringify({version:1,issues:[{...issue,id:uuid,revision:2,attachments:[{...file,fileId:uuid,data:''}]}]})]],
 [['forge:team-issues:v1:'+uuid,JSON.stringify({version:1,issues:[{...issue,title:''},{...issue,number:0},null]})]],
 [['forge:triage-issues:v1:'+uuid,JSON.stringify([triage,{...triage,attachments:[file],status:'unknown ignored'}])]],
 [['forge:cycle-issues:v1:'+uuid,JSON.stringify([cycle,{...cycle,extra:true}])]],
 [['forge:workspace:workspace:initiatives:v1',JSON.stringify({version:1,workspaceProjects:[project],initiatives:[initiative]})]],
 [['forge:team-home:v1:'+uuid,JSON.stringify(home)]],
 [['forge:team-home:v1:'+uuid,JSON.stringify({...home,resources:[{...home.resources[0],sharedWithWorkspace:true},{...home.resources[1],url:'javascript:alert(1)'},{...home.resources[0],body:{type:'unsafe'}},{...home.resources[0],id:uuid,revision:-2}]})]],
 [['forge:workspace:workspace:custom-views:v1:user',JSON.stringify({version:1,views:[view,projectView,{...view,ownerId:'someone'},{...view,filters:{...view.filters,extra:true}}]})]],
 [['forge:team-home:v1:'+uuid,'{"sections":null}']],
 [['forge:team-issues:v1:'+uuid,'{bad JSON']],
 [['forge:team-issues:v1:'+uuid,'{"version":2,"issues":[]}']],
 [['forge:unknown','raw preserved']],
]
const modules={initiatives:true,documents:true,views:true,resources:true,milestones:true}
for(const source of cases)for(const flags of [undefined,modules,{...modules,initiatives:false,documents:false,views:false,resources:false,milestones:false}]){const input={id:uuid,actorId,workspaceId,sources:source.map(([key,raw])=>({key,raw})),defaultStatus:'todo',...(flags?{modules:flags}:{})};const expected=buildImportManifest(input);expected.createdAt=now;importContracts.manifests.push({input,now,expected})}
const duplicate={id:uuid,actorId,workspaceId,sources:[...cases[0],...cases[0],...cases[4]].map(([key,raw])=>({key,raw})),defaultStatus:'todo',modules};const expected=buildImportManifest(duplicate);expected.createdAt=now;importContracts.manifests.push({input:duplicate,now,expected})

// Evaluate the reference's pure checkpoint functions without loading server I/O.
// These are extracted from the owning source, so edits fail the fixture drift gate.
const {readFileSync}=await import('node:fs')
const {documentPlainText}=await import('../apps/forge/src/lib/team-documents.ts')
const {documentBodySchema}=await import('../apps/forge/src/lib/document-contract.ts')
const server=readFileSync(new URL('../apps/forge/src/application/imports/imports.server.ts',import.meta.url),'utf8')
const contentServer=readFileSync(new URL('../apps/forge/src/application/imports/content.server.ts',import.meta.url),'utf8')
const transpiler=new Bun.Transpiler({loader:'ts'})
const summaryCode=contentServer.slice(contentServer.indexOf('export function contentReviewSummary')).replace('export function','function')
const summary=new Function('documentPlainText','documentBodySchema',transpiler.transformSync(summaryCode)+';return contentReviewSummary')(documentPlainText,documentBodySchema)
function extract(source,start,end,name,context={}) {
 const code=source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))).replace('export function','function')
 return new Function(...Object.keys(context),transpiler.transformSync(code)+`;return ${name}`)(...Object.values(context))
}
const encode=extract(server,'function encodeManifest(','async function hydrate(','encodeManifest')
const snapshot=extract(server,'function snapshot(','/** Source bytes','snapshot',{contentReviewSummary:summary})
const dependencies=extract(contentServer,'export function contentDependencies(','async function mappedView(','contentDependencies')
const references=extract(server,'function referenceEntries(','async function reference(','referenceEntries')
importContracts.checkpoints=[]
for(const {expected:manifest} of importContracts.manifests) {
 for(const state of ['pending','review','saved','skipped']) {
  const m=structuredClone(manifest)
  m.referenceContext=[{id:'private reference',title:'not part of client projection'}]
  m.entries.forEach((e,i)=>{e.state=state;e.conflict={fingerprint:'x'.repeat(64),candidates:[{id:uuid,revision:4,title:'Private server title',details:{description:'Server content'}}]};if(state==='saved'&&i%2===1)e.files.forEach(f=>f.fileId=uuid)})
  importContracts.checkpoints.push({input:m,encoded:JSON.parse(encode(m)),snapshot:snapshot(m),filesSnapshot:snapshot(m,true),dependencies:m.entries.map(dependencies)})
 }
}
const many=structuredClone(importContracts.checkpoints.find(c=>c.input.entries.some(e=>e.files.length)).input)
many.entries=Array.from({length:130},(_,i)=>({...structuredClone(many.entries[0]),id:`entry-${i}`,state:i>119?'pending':i>115?'review':'saved'}))
importContracts.checkpoints.push({input:many,encoded:JSON.parse(encode(many)),snapshot:snapshot(many),filesSnapshot:snapshot(many,true),dependencies:many.entries.map(dependencies)})
importContracts.references=[]
for(const kind of ['issue','project','milestone','document','resource','view','initiative']) for(const entryKind of ['issue','view']) for(const same of ['both','source','neither']) for(const local of [true,false]) {
 const entry={kind:entryKind,teamId:'team',sourceKey:'source',sourceChecksum:'checksum'}
 const candidates=[{id:'other',kind,teamId:'other',legacyId:'legacy',sourceKey:'other',sourceChecksum:'other'},{id:'match',kind,teamId:'team',legacyId:'legacy',legacyAliases:['alias'],sourceKey:same==='neither'?'other':'source',sourceChecksum:same==='both'?'checksum':'other'}]
 const manifest={entries:local?candidates:[],referenceContext:local?[{...candidates[1],id:'reference'}]:candidates}
 for(const legacyId of ['legacy','alias',''])importContracts.references.push({manifest,entry,kind,legacyId,expected:references(manifest,entry,kind,legacyId)})
}
