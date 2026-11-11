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
