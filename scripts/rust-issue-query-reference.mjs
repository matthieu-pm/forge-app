import {createHash} from "node:crypto"
import {issueQuerySchema} from "../apps/forge/src/lib/issue-query-contract.ts"
import {defaultIssueDisplay,issueFields} from "../apps/forge/src/lib/issue-view-contract.ts"
export const issueQueries=[]
const actor={workspaceId:"query-workspace",userId:"alice",workspaceRole:"member",authentication:{kind:"session",sessionId:"query-session"},scopes:null}
function add(input){try{
  const expected=issueQuerySchema.parse(input)
  const {cursor,...parameters}=expected
  const binding=createHash("sha256").update(JSON.stringify({parameters,workspace:actor.workspaceId,user:actor.userId,authentication:actor.authentication})).digest("hex")
  issueQueries.push({input,valid:true,expected,actor,binding})
}catch{issueQueries.push({input,valid:false})}}
for(const input of [{},{search:" \uFEFFSearch me  "},{teamIds:[]},{milestone:[]},{cycle:"2026-11-01"},{project:""},{triage:true},{triage:false},{showSnoozed:true},{scope:"backlog"},{scope:"active"},{limit:1},{limit:100},{limit:101},{limit:0},{limit:1.5},{cursor:"not-a-cursor"},{unknown:true},{filters:{}},{display:{layout:"list"}},{filters:{rules:[],match:"any",unknown:true}},{project:null},{teamIds:["invalid"]},{search:"x".repeat(201)},{search:"😀".repeat(200)}])add(input)
for(const personal of ["assigned","created","subscribed","activity","other"])add({personal})
for(const order of ["Priority","Created","Updated","Due date","Title","Status"])for(const descending of [false,true])add({display:{...defaultIssueDisplay(),order,descending}})
for(const field of Object.keys(issueFields))for(const operator of ["is","isNot","contains","notContains","set","notSet","before","after"])add({filters:{match:"all",rules:[{id:field,field,operator,value:"  Expected 😀  "}]}})
for(const value of ["😀".repeat(250),"😀".repeat(251)])add({filters:{match:"any",rules:[{id:"unicode",field:"content",operator:"contains",value}]}})
add({filters:{match:"all",rules:Array.from({length:21},(_,n)=>({id:String(n),field:"status",operator:"is",value:"todo"}))}})
add({display:{...defaultIssueDisplay(),properties:Array(31).fill("ID")}})
const reordered={limit:2,display:Object.fromEntries(Object.entries(defaultIssueDisplay()).reverse()),search:"hello",teamIds:["00000000-0000-4000-8000-000000000001"]}
add(reordered);add(Object.fromEntries(Object.entries(reordered).reverse()))
