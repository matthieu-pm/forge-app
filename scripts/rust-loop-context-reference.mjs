import {readFileSync} from 'node:fs'
import {commentDocumentSchema,commentPlainText,commentMentionIds} from '../apps/forge/src/lib/comment-rich-text.ts'

// Evaluate the owning pure functions unchanged, without loading its database.
const source=readFileSync(new URL('../apps/forge/src/application/loops/loop-context.server.ts',import.meta.url),'utf8')
const code=source.slice(source.indexOf('const list ='),source.indexOf('/** Reload current canonical'))+'\n'+source.slice(source.indexOf('export function loopMatchEvents'))
const js=new Bun.Transpiler({loader:'ts'}).transformSync(code).replace(/\bexport (?=function)/g,'')
const api=new Function('commentDocumentSchema','commentPlainText','commentMentionIds','ApplicationAccessError',js+';return {normalizeLoopSnapshot,loopActivityContext,loopMatchEvents};')(commentDocumentSchema,commentPlainText,commentMentionIds,Error)
export const loopContexts={snapshots:[],activities:[],changes:[]}
const values=[null,false,true,0,1e21,'',' a, b , ',[],['x',null,false,0,{id:'a'},{id:0},{id:{x:1}},{}],{z:1,a:2},[{id:'x'}]]
const keys=['status_id','statusId','status','state','assignee_id','assigneeId','assignee','creator_id','creatorId','created_by_user_id','createdByUserId','creator','delegate_id','agent','project_id','projectId','project','cycle_id','cycleId','cycle','team_id','teamId','team','teamIds','labelIds','labels','ownerId','owner','leadId','lead','targetDate','target_date','description','content','projectIds','projects','memberIds','members','triage','milestones','summary','health','startDate','start_date','endDate','end_date','dueDate','due_date','parent_id','parentId','recurrence','snoozed','estimate','links','attachments','resources','views','dependencyIds','icon','descriptionDoc','timezone','number']
for(const entity of ['issue','project','initiative','cycle','team']){
 for(const v of values){const raw=Object.fromEntries(keys.map(k=>[k,v]));loopContexts.snapshots.push({entity,raw,output:api.normalizeLoopSnapshot(entity,raw)})}
 for(const key of keys)for(const v of [null,'',false,'top']){const raw={id:'item',name:'Name',properties:Object.fromEntries(keys.map(k=>[k,`nested:${k}`])),[key]:v};loopContexts.snapshots.push({entity,raw,output:api.normalizeLoopSnapshot(entity,raw)})}
}
const doc={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Hello '},{type:'mention',attrs:{id:'member',label:'Alice'}}]}]}
const comments=[{id:'one',body:'Hello'},{id:'one',content:'Hello'},{id:'one',text:'Hello'},{id:'one',document:doc},{id:'one',body:doc},{id:'one',document:{bad:true},body:'fallback'},{id:'one',body:'Hello',parentId:'parent'},null,[],{id:1,body:'No'},{body:'No'}]
function activity(raw,event){try{loopContexts.activities.push({raw,event,valid:true,output:api.loopActivityContext(raw,event)})}catch(e){loopContexts.activities.push({raw,event,valid:false,message:e.message})}}
for(const entry of comments)for(const nested of [false,true]){
 const raw={id:'item',properties:nested?{updates:[{id:'update',body:'Update',comments:[entry]}]}:{comments:[entry]}}
 for(const event of [{},{comment:null},{update:null},{comment:false},{comment:[]},{comment:{id:'one',text:'Hello'}},{comment:{id:'one',text:'Hello @Alice',mentionIds:['member','member',7]}},{comment:{id:'one',text:'Hello @Alice',mentionIds:[]}},{comment:{id:'one',text:'changed'}},{update:{id:'update',text:'Update'}}])activity(raw,event)
 for(const before of [null,{id:'item'},raw,{...raw,properties:{comments:[{id:'one',body:'Old'}]}}])for(const event of ['created','updated','started','completed'])loopContexts.changes.push({entity:'issue',event,before,after:raw,output:api.loopMatchEvents('issue',event,before,raw)})
}
for(const flag of [{deleted:true},{deletedAt:'now'},{deleted:false},{deletedAt:0},{deletedAt:[]}]){
 const raw={properties:{comments:[{id:'one',body:'Hello',...flag}]}}
 activity(raw,{comment:{id:'one',text:'Hello'}})
 loopContexts.changes.push({entity:'project',event:'updated',before:null,after:raw,output:api.loopMatchEvents('project','updated',null,raw)})
}
