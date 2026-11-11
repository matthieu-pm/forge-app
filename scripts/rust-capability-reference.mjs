import {readFileSync} from 'node:fs'
import {z} from '../apps/forge/node_modules/zod/index.js'
import {teamSummarySchema,updateTeamInputSchema} from '../apps/forge/src/application/teams/team-schemas.ts'
import {createAgentArtifactInputSchema,agentArtifactRecordSchema} from '../apps/forge/src/application/agents/artifact-contract.ts'
const source=readFileSync(new URL('../apps/forge/src/adapters/agents/forge-capabilities.server.ts',import.meta.url),'utf8')
const declarations=source.slice(source.indexOf('const listTeamsInputSchema'),source.indexOf('const agentStore ='))+source.slice(source.indexOf('const createArtifactCapability'),source.indexOf('export const forgeApprovalService'))
const workspace=readFileSync(new URL('../apps/forge/src/application/workspaces/workspace.server.ts',import.meta.url),'utf8')
const schema=workspace.slice(workspace.indexOf('export const workspaceDescriptionSchema'),workspace.indexOf('export async function'))
const workspaceDescriptionSchema=new Function('z',schema.replace('export const','const')+';return workspaceDescriptionSchema;')(z)
const caps=new Function('z','defineCapability','teamSummarySchema','updateTeamInputSchema','workspaceDescriptionSchema','createAgentArtifactInputSchema','agentArtifactRecordSchema',new Bun.Transpiler({loader:'ts'}).transformSync(declarations)+'\nreturn [listTeamsCapability,getTeamCapability,describeWorkspaceCapability,updateTeamCapability,createArtifactCapability];')(z,definition=>definition,teamSummarySchema,updateTeamInputSchema,workspaceDescriptionSchema,createAgentArtifactInputSchema,agentArtifactRecordSchema)
export const agentCapabilities={descriptors:caps.map(cap=>cap.descriptor),inputs:[]}
for(const cap of caps){
 const inputs=[null,true,[],{}, {extra:1},...['cursor','limit','id','slug','settings'].flatMap(key=>[null,'',false,0,1,100,101,' forge ','00000000-0000-4000-8000-000000000001',{}].map(value=>({[key]:value}))),{id:'00000000-0000-4000-8000-000000000001',slug:'forge'},{slug:'forge',settings:{description:' Updated '}},{slug:' Forge ',settings:{name:'New'}},{slug:'forge',settings:{description:null}},{name:'hello.txt',contentType:'text/plain',content:'hello'}]
 for(const input of inputs){const parsed=cap.inputSchema.safeParse(input);agentCapabilities.inputs.push({id:cap.descriptor.id,input,valid:parsed.success,...(parsed.success?{value:parsed.data}:{})})}
}
