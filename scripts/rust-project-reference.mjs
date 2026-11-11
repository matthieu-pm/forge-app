import {projectChangesSchema,projectFields} from '../apps/forge/src/lib/shared-project-contract.ts'
import {initialProjectStatuses,projectStatusDirectorySchema} from '../apps/forge/src/lib/project-statuses.ts'
import {teamLabelDirectorySchema} from '../apps/forge/src/lib/team-labels.ts'
import {targetTimestamp} from '../apps/forge/src/lib/initiatives.ts'
import {reconcileProjectEntries,assertUniqueMilestones} from '../apps/forge/src/application/planning/project-content.ts'
export const projectCases=[]
const schemas={changes:projectChangesSchema,fields:projectFields,statuses:projectStatusDirectorySchema,labels:teamLabelDirectorySchema}
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function add(kind,input){try{projectCases.push({kind,input,valid:true,expected:schemas[kind].parse(input)})}catch{projectCases.push({kind,input,valid:false})}}
const fields={name:' Project ',status:'Active',teamIds:[uuid(1)]}
const change={id:uuid(2),expectedRevision:null,changes:fields}
add('fields',fields);add('changes',[change]);add('changes',[]);add('changes',Array(101).fill(change));add('changes',[{...change,changes:{}}]);add('changes',[{...change,expectedRevision:1.5}])
for(const key of Object.keys(fields)){const v={...fields};delete v[key];add('fields',v);add('changes',[{...change,changes:v}])}
for(const [key,values] of Object.entries({name:['',' ',null,'😀'.repeat(200),'😀'.repeat(201)],teamIds:[[],['local'],Array(101).fill(uuid(1))],dependencyIds:[[uuid(2)],['local'],null],leadId:['x'.repeat(201),null],memberIds:[[''],Array(101).fill('u')],labelIds:[[''],['x'.repeat(201)]],milestones:[[{id:'m',name:' First ',completed:false,extra:true}],Array(501).fill({id:'m',name:'M',completed:false})],description:[null,{type:'doc',content:[]},{type:'arbitrary'}],status:['Paused','Invalid'],startDate:['2028-02-29','2026-02-29','2026-Q4'],unknown:[true],creatorId:['forged']}))for(const value of values)add('changes',[{...change,changes:{...fields,[key]:value}}])
for(const relocation of [{milestoneId:'m'},{milestoneId:'m',targetId:uuid(3),targetRevision:1},{milestoneId:'m',convertId:uuid(4)},{milestoneId:''},{milestoneId:'m',unknown:true}])add('changes',[{...change,expectedRevision:0,changes:{},relocation}])
const status=initialProjectStatuses();add('statuses',status)
for(const modify of [v=>v.statuses.pop(),v=>v.statuses.push(v.statuses[0]),v=>v.statuses[1].name=v.statuses[0].name.toUpperCase(),v=>v.deleted.push({...v.statuses[0],index:0}),v=>v.statuses[0].color='#123',v=>v.version=-1,v=>v.statuses[0].description=' x ',v=>v.extra=true]){const v=structuredClone(status);modify(v);add('statuses',v)}
const labels={version:1,catalogRevision:0,labels:[{id:'l',name:' Label ',description:'',color:'#abcdef',groupId:null,issues:0,lastApplied:null,createdAt:'2026-11-11T00:00:00Z'}],groups:[],inheritedCount:0};add('labels',labels)
for(const key of Object.keys(labels.labels[0])){const v=structuredClone(labels);delete v.labels[0][key];add('labels',v)}
export const projectDates=['','0000','0099-Q4','2026','2026-H1','2026-Q4','2026-02','2028-02','2028-02-29','0000-01-01'].map(value=>({value,expected:Number.isFinite(targetTimestamp(value))?new Date(targetTimestamp(value)).toISOString().slice(0,10):null}))
const base={id:'post',text:'Text',authorId:'alice',createdAt:'2026-11-01T00:00:00Z',attachments:[],reactions:[],comments:[]}
export const projectContent=[]
function content(role,userId,before,submitted){const actor={workspaceId:'w',userId,workspaceRole:role,scopes:null,authentication:{kind:'session',sessionId:'s'}};try{projectContent.push({actor,before,submitted,valid:true,expected:reconcileProjectEntries(actor,before,submitted,'2026-11-11T00:00:00.000Z')})}catch{projectContent.push({actor,before,submitted,valid:false})}}
for(const role of ['member','admin'])for(const user of ['alice','bob'])for(const submitted of [[],[base],[{...base,text:'Edited'}],[{...base,authorId:'forged',createdAt:'2026-11-09T00:00:00Z'}],[{...base,reactions:[{emoji:'👍',userIds:['bob','bob']}]}],[{...base,comments:[{...base,id:'reply'}]}],[base,base]])content(role,user,[base],submitted)
content('member','alice',[],[{...base,attachments:[{id:'x',data:'data:text/plain;base64,QQ=='}]}]);content('member','alice',[],[{...base,reactions:[{emoji:'👍',userIds:['alice']}]}])
const reacting={...base,reactions:[{emoji:'👍',userIds:['alice','bob']}]};for(const users of [[],['alice'],['bob'],['alice','bob','charlie']])content('admin','alice',[reacting],[{...reacting,reactions:[{emoji:'👍',userIds:users}]}])
content('member','alice',[],['a','A','ä','z','Z','_','-','é'].map(id=>({...base,id})))
export const projectMilestones=[]
for(const value of [[],[{id:'1',name:'First'}],[{id:'1',name:'First'},{id:'1',name:'Second'}],[{id:'1',name:'First',aliases:['Old']},{id:'2',name:'Old'}],[{id:'1',name:'1',aliases:['1']}]]){try{assertUniqueMilestones(value);projectMilestones.push({value,valid:true})}catch{projectMilestones.push({value,valid:false})}}
