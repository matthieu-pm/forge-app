// Evaluate the pinned runtime's pure session-budget rules without any providers.
import { readFileSync, writeFileSync } from 'node:fs'
import {resolveRuntimeTokenLimits,grantRuntimeTokenLimits,remainingRuntimeTokenQuota,findRuntimeTokenLimitViolation} from '../services/agent-runtime/node_modules/eve/dist/src/harness/session-token-limits.js'
import {createSessionLimitContinuationRequest} from '../services/agent-runtime/node_modules/eve/dist/src/harness/session-limit-continuation.js'
const source = value => ({inputTokens:value.input,outputTokens:value.output})
const native = value => ({input:value.inputTokens,output:value.outputTokens})
const limits=[]
for(const configured of [{input:10,output:5},{input:200000,output:50000}])
for(const stored of [undefined,{input:35,output:15},{input:400000,output:100000}])
for(const usage of [{input:0,output:0},{input:9,output:4},{input:10,output:0},{input:0,output:5},{input:35,output:15},{input:200001,output:50001},{input:900000,output:100000}]) {
 const runtime=resolveRuntimeTokenLimits({configured:source(configured),stored:stored&&source(stored)})
 limits.push({configured,stored,usage,runtime:native(runtime),grant:native(grantRuntimeTokenLimits({configured:source(configured),usage:source(usage)})),remaining:native(remainingRuntimeTokenQuota({runtime,usage:source(usage)})),violation:findRuntimeTokenLimitViolation({configured:source(configured),runtime,usage:source(usage)})})
}
const requests=[]
for(const kind of ['input','output']) for(const limit of [1,999,1000,1050,1150,1250,1950,9950,999999,1000000,1250000,2550000,200000,50000,9007199254740991]) requests.push(createSessionLimitContinuationRequest({sessionId:'fixture',violation:{kind,limit,usedTokens:limit}}))
const path=new URL('../rust/crates/forge-agent-runtime/data/session-budget-reference.json',import.meta.url)
const text=JSON.stringify({limits,requests},null,2)+'\n'
if(process.argv.includes('--check')) {if(readFileSync(path,'utf8')!==text)throw Error('Session budget reference changed')}else writeFileSync(path,text)
console.log(`Session budget reference: ${limits.length} limits and ${requests.length} requests`)
