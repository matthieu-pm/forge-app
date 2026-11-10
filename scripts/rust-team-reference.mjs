import { createTeamInputSchema, updateTeamSettingsSchema, slugifyTeamName } from "../apps/forge/src/application/teams/team-schemas.ts"
import { defaultDefinitionValue } from "../apps/forge/src/lib/issue-definition-contract.ts"
import { createApiKeyInputSchema } from "../apps/forge/src/application/api-keys/api-key-contract.ts"

const base={name:"Engineering",identifier:"ENG",icon:{kind:"icon",value:"UserGroup03Icon",color:"#818cf8"},timezone:"Europe/Paris"}
const zones=["Europe/Paris","europe/paris","UTC","GMT","Etc/UTC","US/Pacific","Asia/Calcutta","America/Ciudad_Juarez","+01:00","-23:59","+0100","+01","+24:00","+aéxx","GMT+1","Invalid/Timezone",""]
const inputs=[base, {...base,name:" Équipe produit ",identifier:" ép "}, {...base,name:"ＡＡ product",identifier:"ßab"},
  ...["", " ", "a".repeat(80), "a".repeat(81), "😀".repeat(40), "😀".repeat(41),"😀".repeat(80),"😀".repeat(81)].map(name=>({...base,name})),
  ...["abcde", "abcdef", "a-1", "123", "   a1   ", "", "ß"].map(identifier=>({...base,identifier})),
  ...zones.map(timezone=>({...base,timezone})),
  ...[{kind:"emoji",value:" 👩🏽‍💻 ",color:"#94a3b8"},{kind:"icon",value:"not-icon",color:"#818cf8"},{kind:"emoji",value:"a".repeat(33),color:"#818cf8"},{...base.icon,color:"#abcdef"},{...base.icon,ignored:"stripped"}].map(icon=>({...base,icon})),
  {...base,extra:1},{...base,name:null},{...base,icon:null},null,
]
function cases(schema,values){return values.map(input=>{const result=schema.safeParse(input);return {input,valid:result.success,...result.success?{expected:result.data}:{}}})}
export const teamContracts={
  keyNames:["😀".repeat(32),"😀".repeat(33),"  Integration  ","\ufeffIntegration\ufeff",""].map(name=>{const input={name,scopes:["teams:read"]};const result=createApiKeyInputSchema.safeParse(input);return{input,valid:result.success,...result.success?{expected:result.data}:{}}}),
  create:cases(createTeamInputSchema,inputs),
  settings:cases(updateTeamSettingsSchema,[{}, {name:" New name "},{identifier:"  new "},{description:"  text  "},{description:"a".repeat(501)},{name:null},{unknown:true},{issueEmailEnabled:true},{detailedHistoryEnabled:false},{estimationScheme:"tshirt"},{estimationScheme:"other"},...zones.map(timezone=>({timezone}))]),
  slugs:["Équipe produit", "ＡＡ product", "東京", "a😀b", "Å① K ﬁ ﬀ", "--- spaces ---", "𐐀Z", "a".repeat(63)+" b", " a\u0085b ", ""].map(input=>({input,expected:slugifyTeamName(input)})),
  defaults:defaultDefinitionValue(),
}
