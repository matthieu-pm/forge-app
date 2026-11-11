// Compile the reference's declarative preference schema into data consumed by Rust.
// Unknown validation/normalization rules fail the gate instead of being discarded.
import {readFileSync,writeFileSync} from 'node:fs'
import {accountPreferenceGroups,accountPreferenceDefaults} from '../apps/forge/src/lib/account-preference-contract.ts'
import {workspaceViewSchemas,workspaceViewDefaults} from '../apps/forge/src/lib/workspace-preference-contract.ts'
export function compile(schema){
 const d=schema._zod.def, out={kind:d.type}
 switch(d.type){
 case 'object':out.fields=Object.fromEntries(Object.entries(d.shape).map(([k,s])=>[k,compile(s)]));out.strict=d.catchall?._zod.def.type==='never';break
 case 'array':out.element=compile(d.element);break
 case 'enum':out.values=Object.values(d.entries);break
 case 'literal':out.values=d.values;break
 case 'optional':case 'default':out.inner=compile(d.innerType);if(d.type==='default')out.value=d.defaultValue;break
 case 'boolean':case 'string':case 'number':break
 default:throw Error(`Unsupported preference schema ${d.type}`)
 }
 out.checks=(d.checks??[]).map(c=>{
  const r=c._zod.def
  switch(r.check){
   case 'min_length':return {kind:'min',value:r.minimum}
   case 'max_length':return {kind:'max',value:r.maximum}
   case 'greater_than':if(r.inclusive)return {kind:'minimum',value:r.value};break
   case 'number_format':if(r.format==='safeint')return {kind:'integer'};break
   case 'string_format':if(r.format==='datetime'&&!r.offset&&!r.local&&r.precision===null)return {kind:'datetime'};if(r.format==='regex'&&!r.pattern.flags)return {kind:'pattern',value:r.pattern.source};break
   case 'overwrite':if(r.tx.toString()==='(input) => input.trim()')return {kind:'trim'};break
   case 'custom':{
    const fn=r.fn.toString()
    if(fn==='(items) => new Set(items.map((item) => item.id)).size === items.length')return {kind:'uniqueIds'}
    if(fn==='(types) => new Set(types).size === types.length')return {kind:'unique'}
    if(fn==='(value) => ["New issues", "Status changes"].includes(value)')return {kind:'choices',value:['New issues','Status changes']}
   }
  }
  throw Error(`Unsupported preference check ${JSON.stringify(r)}`)
 })
 return out
}
export const preferenceSchemas={version:1,account:compile(accountPreferenceGroups),workspace:Object.fromEntries(Object.entries(workspaceViewSchemas).map(([k,s])=>[k,compile(s)])),defaults:{account:accountPreferenceDefaults,workspace:workspaceViewDefaults}}
const file=new URL('../rust/crates/forge-core/data/preference-schemas.json',import.meta.url), expected=JSON.stringify(preferenceSchemas,null,2)+'\n'
if(process.argv.includes('--check')){if(readFileSync(file,'utf8')!==expected)throw Error('Rust preference schema drift')}else{writeFileSync(file,expected)}
