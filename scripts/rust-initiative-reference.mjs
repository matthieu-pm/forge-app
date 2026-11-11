import {initiativeChangesSchema,initiativeFields} from '../apps/forge/src/lib/shared-initiative-contract.ts'
import {initiativeSchema,initiativesSettingsSchema,blankInitiative} from '../apps/forge/src/lib/initiatives.ts'
export const initiativeCases=[]
const schemas={changes:initiativeChangesSchema,fields:initiativeFields,initiative:initiativeSchema,settings:initiativesSettingsSchema}
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function add(kind,input){try{initiativeCases.push({kind,input,valid:true,expected:schemas[kind].parse(input)})}catch{initiativeCases.push({kind,input,valid:false})}}
const full={...blankInitiative('alice'),id:uuid(1),name:' Initiative ',number:1,createdAt:'2026-11-11T00:00:00Z',updatedAt:'2026-11-11T00:00:00Z'}
const fields=initiativeFields.strip().parse(full)
add('initiative',full);add('fields',fields)
for(const kind of ['fields','initiative'])for(const key of Object.keys(kind==='fields'?fields:full)){const v=structuredClone(kind==='fields'?fields:full);delete v[key];add(kind,v)}
const change={id:uuid(1),expectedRevision:null,changes:{name:' Strategy '}}
add('changes',[change]);add('changes',[]);add('changes',Array(101).fill(change));add('changes',[{...change,changes:{}}])
for(const [field,values] of Object.entries({name:['',' ',null,'😀'.repeat(200)],ownerId:['','x'.repeat(201)],status:['Proposed','Paused','Completed'],targetDate:['2028-02-29','2026-02-29','0099-H2'],updates:[[{id:'u',text:' Hello ',health:'On track',authorId:'alice',createdAt:'2026-11-11T00:00:00Z'}],Array(501).fill({})],comments:[[{id:'c',text:'Comment',authorId:'alice',createdAt:'2026-11-11T00:00:00Z',comments:[{text:'stripped'}]}]],projects:[[]],resources:[[]],description:[null,{type:'doc',content:[]}]}))for(const value of values)add('changes',[{...change,changes:{[field]:value}}])
for(const ids of [[],[uuid(2)],['legacy'],Array(501).fill(uuid(2))])add('changes',[{...change,addProjectIds:ids}])
for(const value of [{enabled:true,schedule:'none'},{enabled:false,schedule:'8-weeks'},{enabled:true,schedule:'1-week',ignored:true},{enabled:true,schedule:'9-weeks'},{enabled:true},{schedule:'none'}])add('settings',value)
