import {readFileSync,writeFileSync} from 'node:fs'
import {agentCapabilities} from './rust-capability-reference.mjs'
const path=new URL('../rust/agent-capabilities.json',import.meta.url)
const output=JSON.stringify(agentCapabilities.descriptors,null,2)+'\n'
if(process.argv.includes('--check')){
 if(readFileSync(path,'utf8')!==output)throw new Error('Rust capability descriptors drifted from the owning source.')
}else writeFileSync(path,output)
