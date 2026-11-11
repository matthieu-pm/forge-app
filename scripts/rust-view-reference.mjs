import {savedViewDefinitionSchema,savedViewMutationSchema} from '../apps/forge/src/lib/saved-view-contract.ts'
import {defaultIssueDisplay} from '../apps/forge/src/lib/issue-view-contract.ts'
import {defaultProjectPreferences,visibleProjects} from '../apps/forge/src/lib/projects.ts'
import {emptyInitiatives} from '../apps/forge/src/lib/initiatives.ts'
import {teamResourceFieldsSchema,teamResourceCommandSchema,teamResourceUrl} from '../apps/forge/src/lib/team-resources-contract.ts'
export const viewContracts={cases:[],urls:[],projects:[]}
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const schemas={definition:savedViewDefinitionSchema,mutation:savedViewMutationSchema,resources:teamResourceFieldsSchema,resourceCommand:teamResourceCommandSchema}
function add(kind,input){try{viewContracts.cases.push({kind,input,valid:true,expected:schemas[kind].parse(input)})}catch{viewContracts.cases.push({kind,input,valid:false})}}
const metadata={version:1,name:' View ',description:'Description',icon:null,visibility:'personal'}
const issues={...metadata,kind:'issues',filters:{match:'all',rules:[]},display:defaultIssueDisplay()}
const projects={...metadata,kind:'projects',filters:[],display:defaultProjectPreferences()}
for(const full of [issues,projects]){
  add('definition',full)
  for(const key of Object.keys(full)){const v=structuredClone(full);delete v[key];add('definition',v)}
  for(const patch of [{version:2},{extra:true},{visibility:'team'},{visibility:'team',teamId:uuid(1)},{teamId:uuid(2)},{icon:{kind:'icon',value:'Folder01Icon',color:'#818cf8',extra:true}},{icon:{kind:'emoji',value:' 🛠️ ',color:'#818cf8'}},{icon:{kind:'emoji',value:'😀',color:'#123456'}},{name:'😀'.repeat(80)},{name:'😀'.repeat(81)}])add('definition',{...full,...patch})
  for(const key of Object.keys(full.display)){const display=structuredClone(full.display);delete display[key];add('definition',{...full,display})}
  add('definition',{...full,display:{...full.display,extra:true}})
}
for(const field of ['project','parentId','assignee','unknown'])for(const value of ['',uuid(1),'😀'.repeat(500),'😀'.repeat(501)])add('definition',{...issues,filters:{match:'all',rules:[{id:'r',field,operator:'is',value}]}})
for(const filters of [{match:'all',rules:[],extra:true},{match:'all',rules:[{id:'r',field:'status',operator:'is',value:'todo',extra:true}]},{match:'any',rules:Array(21).fill({id:'r',field:'status',operator:'is',value:'todo'})}])add('definition',{...issues,filters})
for(const filters of [[{field:'Teams',value:uuid(1)}],[{field:'Initiatives',value:''}],[{field:'Status',value:'Active',extra:true}],Array(21).fill({field:'Status',value:'Active'})])add('definition',{...projects,filters})
for(const key of ['favoriteIds','subscribedIds','views','properties'])add('definition',{...projects,display:{...projects.display,[key]:[key==='properties'?'Bad property':'unexpected']}})
for(const mutation of [{action:'save',id:uuid(1),expectedRevision:null,definition:issues},{action:'save',id:uuid(1),expectedRevision:0,definition:projects},{action:'delete',id:uuid(1),expectedRevision:1},{action:'favorite',id:uuid(1),favorite:true}]){add('mutation',mutation);add('mutation',{...mutation,extra:true});add('mutation',{...mutation,id:'legacy'})}
const board={sections:[{id:uuid(1),name:' Section '}],links:[{id:uuid(2),title:' Link ',url:' HTTPS://Example.test:443/path/../docs ',sectionId:uuid(1)}],order:[`link:${uuid(2)}`,`document:${uuid(3)}`]}
for(const input of [board,{sections:[],links:[],order:[]},{...board,extra:true},{...board,sections:[...board.sections,...board.sections]},{...board,links:[...board.links,...board.links]},{...board,order:[...board.order,...board.order]},{...board,sections:[]},{...board,order:['document:'+'-'.repeat(36)]},{...board,order:['section:'+uuid(1)]},{...board,sections:Array(101).fill(board.sections[0])}])add('resources',input)
for(const raw of ['https://example.test','  http://EXAMPLE.test:80/a/../b?q=1#x  ','https://bücher.example/😀','https://user:pass@example.test','https://:@example.test','https://example.test/\npath','\u0000https://example.test','https://example.test/\u007f','data:text/html,test','javascript:alert(1)','file:///tmp/a','/relative','http:example.test','https://example.test/a b']){viewContracts.urls.push({raw,expected:teamResourceUrl(raw)});add('resources',{...board,links:[{...board.links[0],url:raw}]})}
for(const patch of [{},{expectedRevision:-1},{expectedRevision:1.5},{teamId:'legacy'},{extra:true}])add('resourceCommand',{teamId:uuid(1),expectedRevision:0,fields:board,...patch})
const catalog=[
 {id:uuid(1),name:'éclair',status:'Active',health:'On track',priority:'High',teamIds:[uuid(1)],leadId:'alice',memberIds:['bob'],labelIds:['label'],summary:'Coffee',targetDate:'2026-Q4',createdAt:'2026-01-01',updatedAt:'2026-10-02'},
 {id:uuid(2),name:'Alpha',status:'Completed',health:'At risk',priority:'No priority',teamIds:[],summary:'',targetDate:'',createdAt:'2025-01-01',updatedAt:'2026-10-01'},
 {id:uuid(3),name:'alpha',status:'Canceled',health:'Off track',priority:'Urgent',teamIds:[uuid(2)],leadId:'bob',memberIds:['alice'],summary:'Launch',targetDate:'2026-11',createdAt:'2026-01-02',updatedAt:'2026-10-03'},
 {id:uuid(4),name:'Éclair',status:'Backlog',health:'On track',priority:'Low',teamIds:[uuid(1)],targetDate:'2026-11-20'},
]
function projectCase(definition){viewContracts.projects.push({catalog,definition,expected:visibleProjects(catalog,emptyInitiatives(),definition.filters,definition.display,definition.teamId)})}
for(const ordering of ['Manual','Name','Priority','Status','Health','Target date','Created','Updated'])for(const descending of [false,true])projectCase({...projects,display:{...projects.display,ordering,descending}})
for(const [field,value] of [['Status','Active'],['Priority','Urgent'],['Labels','label'],['Teams',''],['Teams',uuid(1)],['Lead','alice'],['Members','alice'],['Health','On track'],['Target date','2026-Q4'],['Specific project',uuid(1)],['Title & summary','COFFEE']])projectCase({...projects,filters:[{field,value}]})
for(const closed of ['Hide','Only'])projectCase({...projects,display:{...projects.display,closed}})
projectCase({...projects,teamId:uuid(1)})
