import {createRequire} from "node:module"
import {issueDraftSchema,issueSchema,blankIssueDraft} from "../apps/forge/src/lib/issue-record-contract.ts"
import {createCanonicalIssueSchema,legacyIssueSource} from "../apps/forge/src/lib/canonical-issue-contract.ts"
import {editIssueBatchSchema} from "../apps/forge/src/lib/canonical-issue-edit-contract.ts"
import {initiativeProjectSchema} from "../apps/forge/src/lib/initiatives.ts"
import {documentSchema} from "../apps/forge/src/lib/template-contract.ts"
import {validateCommentDocument,validateCommentDraft,commentFromText,commentPlainText,commentMentionIds,safeCommentLink} from "../apps/forge/src/lib/comment-rich-text.ts"
import {issueCommentCommandSchema} from "../apps/forge/src/lib/issue-comment-contract.ts"
import {issueHistoryQuerySchema,issueHistoryEnvelopeSchema} from "../apps/forge/src/lib/issue-history-contract.ts"
import {changeRelationshipSchema,relationshipQuerySchema,relationshipSearchSchema} from "../apps/forge/src/lib/issue-relationship-contract.ts"
import {issueEngagementCommandSchema,normalizeReactionEmoji,issueSubscriberIds} from "../apps/forge/src/lib/issue-engagement-contract.ts"
import {issueLifecycleSchema,inactiveIssuesSchema} from "../apps/forge/src/lib/issue-lifecycle-contract.ts"
const require=createRequire(new URL("../apps/forge/package.json",import.meta.url))
export const reactionEmoji=[...new Set(require("emojibase-data/en/compact.json").flatMap(item=>[item.unicode,...(item.skins?.map(s=>s.unicode)??[])]).map(normalizeReactionEmoji))].sort()
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`
const date="2026-11-01T00:00:00.000Z"
export const issueCases=[]
const schemas={draft:issueDraftSchema,issue:issueSchema,create:createCanonicalIssueSchema,edit:editIssueBatchSchema,project:initiativeProjectSchema,document:documentSchema,comment:issueCommentCommandSchema,historyQuery:issueHistoryQuerySchema,history:issueHistoryEnvelopeSchema,relationship:changeRelationshipSchema,relationshipQuery:relationshipQuerySchema,relationshipSearch:relationshipSearchSchema,engagement:issueEngagementCommandSchema}
schemas.lifecycle=issueLifecycleSchema
schemas.inactive=inactiveIssuesSchema
function add(kind,input){try{const expected=kind==="commentDocument"?validateCommentDocument(input):kind==="commentDraft"?validateCommentDraft(input):schemas[kind].parse(input);issueCases.push({kind,input,valid:true,expected})}catch{issueCases.push({kind,input,valid:false})}}
function mutate(kind,base,change){const v=structuredClone(base);change(v);add(kind,v)}
const draft=blankIssueDraft();add("draft",draft)
for(const key of Object.keys(draft))mutate("draft",draft,v=>{delete v[key]})
for(const [key,value] of Object.entries({unknown:true,assignee:null,estimate:null,dueDate:"2026-99-99",descriptionDoc:{type:"arbitrary"},cycle:"legacy-date"}))mutate("draft",draft,v=>{v[key]=value})
const create={teamId:uuid(1),commandKey:"create-1",draft:{...draft,title:"  New issue  "}}
add("create",create)
for(const value of [null,"",uuid(2)])mutate("create",create,v=>{v.assigneeId=value})
for(const value of ["", "2026-11-01", "2026-02-30", uuid(5), "legacy-cycle"])mutate("create",create,v=>{v.draft.cycle=value})
for(const value of [[],["Child"],[" "],Array(101).fill("Child")])mutate("create",create,v=>{v.draft.subIssues=value})
for(const url of ["https://example.test","HTTP://example.test/a"," https://example.test","https:example.test","ftp://example.test","javascript:alert(1)","https://user:password@example.test","https://例え.テスト","http://example.test\n"])mutate("create",create,v=>{v.draft.links=[{title:"Link",url}]})
for(const data of ["data:text/plain;base64,SGVsbG8=","","data:text/plain,Hello","data:text/plain;base64,!!!!"])mutate("create",create,v=>{v.draft.attachments=[{name:"hello.txt",data}]})
mutate("create",create,v=>{v.draft.attachments=[{fileId:uuid(8),name:"ready.txt",data:"data:text/plain;base64,QQ=="}]})
mutate("create",create,v=>{v.unknown=true})
mutate("create",create,v=>{v.draft.title="😀".repeat(240)})
const issue={...draft,id:uuid(1),number:1,title:" Issue ",createdAt:date,updatedAt:date,statusChangedAt:date,creator:"user",suggestedLabel:"",completedAt:null}
add("issue",issue);mutate("issue",issue,v=>{v.comments=[{id:uuid(2),author:"other",body:"Original",createdAt:date}]})
const edit={teamId:uuid(1),commandKey:uuid(2),edits:[{issueId:uuid(3),expectedRevision:0,changes:{title:"  Updated  "}}]}
add("edit",edit);mutate("edit",edit,v=>{v.edits=[]});mutate("edit",edit,v=>{v.edits.push(v.edits[0])});mutate("edit",edit,v=>{v.edits[0].changes={}});mutate("edit",edit,v=>{v.edits[0].changes={activity:[]}});mutate("edit",edit,v=>{v.edits[0].changes={parentId:"local"}})
const project={id:"local-project",name:" Project ",status:"Active",teamIds:[uuid(1)],health:"On track"}
add("project",project)
for(const startDate of ["", "2026", "2026-Q1", "2026-H2", "2026-11", "2026-11-01", "2026-02-30", "2026-Q5"])mutate("project",project,v=>{v.startDate=startDate})
for(const slackChannelUrl of ["","https://team.slack.com/archives/channel","https://slack.com/","http://slack.com/","https://slack.com.evil.test/"])mutate("project",project,v=>{v.slackChannelUrl=slackChannelUrl})
mutate("project",project,v=>{v.comments=[{id:uuid(1),text:" Note ",authorId:"user",createdAt:date}]})
mutate("project",project,v=>{v.milestones=[{id:"m1",name:" Milestone ",completed:false,description:{type:"doc",content:[{type:"paragraph"}]}}]})
mutate("create",create,v=>{v.projectImport=project;v.draft.project="local-project"})
for(const doc of [
  null, {}, {type:"doc"},
  {type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"Hello"}]}]},
  {type:"doc",content:[{type:"html",text:"<script/>"}]},
  {type:"doc",content:[{type:"image",attrs:{src:"https://example.test/image.png"}}]},
  {type:"doc",content:[{type:"image",attrs:{src:"javascript:alert(1)"}}]},
  {type:"doc",content:[{type:"paragraph",content:[{type:"text",text:"Unsafe",marks:[{type:"link",attrs:{href:"javascript:alert(1)"}}]}]}]}
]) add("document",doc)
const documents=[commentFromText("Hello\nWorld"),commentFromText(""),commentFromText(" "),{type:"doc",content:[{type:"paragraph",content:[{type:"mention",attrs:{id:"member",label:"Member"}},{type:"text",text:" hi"}]}]}]
for(const doc of documents){add("commentDocument",doc);add("commentDraft",doc)}
for(const node of [{type:"image",attrs:{src:"https://example.test/a"}},{type:"text",text:"plain",attrs:{}},{type:"text",text:"plain",marks:[{type:"underline"}]},{type:"text",text:"plain",marks:[{type:"link",attrs:{href:"https://example.test",target:"_blank",rel:"noopener"}}]},{type:"text",text:"plain",marks:[{type:"link",attrs:{href:"https://user:password@example.test"}}]},{type:"hardBreak",content:[]},{type:"mention",attrs:{id:"member",label:"spoofed",extra:true}}])add("commentDocument",{type:"doc",content:[{type:"paragraph",content:[node]}]})
for(const attrs of [null,{},[],true,"",{language:null},{language:"javascript"}])add("commentDocument",{type:"doc",content:[{type:"codeBlock",attrs,content:[{type:"text",text:"const n=1"}]}]})
for(const length of [10000,10001])add("commentDocument",commentFromText("x".repeat(length)))
const comment={commandKey:uuid(1),teamId:uuid(2),issueId:uuid(3),commentId:uuid(4),action:"create",document:commentFromText("Hello")}
add("comment",comment);for(const action of ["edit","delete","restore"])mutate("comment",comment,v=>{v.action=action});mutate("comment",comment,v=>{delete v.document});mutate("comment",comment,v=>{v.uploadIds=[uuid(1),uuid(1)]})
add("historyQuery",{issueId:uuid(1)});add("historyQuery",{issueId:uuid(1),limit:101})
const history={version:1,actor:{userId:"user",name:"User",kind:"session"}};add("history",history);mutate("history",history,v=>{v.changes=[{field:"description",from:"",to:"",body:"untrusted"}]})
const relationship={commandKey:uuid(1),issueId:uuid(2).toUpperCase(),expectedRevision:0,targetId:uuid(3),expectedTargetRevision:1,kind:"parent",action:"add"};add("relationship",relationship);mutate("relationship",relationship,v=>{v.targetId=v.issueId.toLowerCase()});add("relationshipQuery",{issueId:uuid(1)});add("relationshipSearch",{issueId:uuid(1),search:" Search "})
for(const emoji of ["👍","❤️","\uFE0F","👨‍👩‍👦","not an emoji",""])add("engagement",{commandKey:uuid(1),teamId:uuid(2),issueId:uuid(3),action:"reaction",emoji,present:true})
add("engagement",{commandKey:uuid(1),teamId:uuid(2),issueId:uuid(3),action:"subscription",subscribed:false})
for(const action of ["archive","unarchive","delete","restore","purge"])add("lifecycle",{commandKey:uuid(1),teamId:uuid(2),issueId:uuid(3),expectedRevision:0,action})
for(const kind of ["deleted","archived","active"])add("inactive",{teamId:uuid(1),kind})
add("inactive",{teamId:uuid(1),kind:"deleted",after:"bad-cursor"})
export const issuePure={
    legacy:[undefined,null,"",uuid(2)].map(assignee=>({draft:{...draft,assignee:"original",subIssues:["Child"]},...(assignee!==undefined?{assignee}:{}),expected:legacyIssueSource({...draft,assignee:"original",subIssues:["Child"]},assignee)})),
    comments:documents.filter(d=>{try{validateCommentDraft(d);return true}catch{return false}}).map(doc=>({doc,plain:commentPlainText(doc),ids:commentMentionIds(doc)})),
    links:["https://example.test","mailto:test@example.test","https://user:password@example.test"," https://example.test","http://example.test\n","javascript:alert(1)"].map(value=>({value,valid:safeCommentLink(value)})),
    subscribers:["","alice,bob,alice"," alice,\uFEFFbob , ,alice"].map(value=>({value,expected:issueSubscriberIds(value)}))
}
