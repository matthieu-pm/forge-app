import {jobStore} from '../apps/forge/src/application/jobs/job-store.ts'
import {jobCommand} from '../apps/forge/src/application/jobs/job-cli.ts'
const id='00000000-0000-0000-0000-000000000001'
const requestId='00000000-0000-0000-0000-000000000002'
const operatorId='00000000-0000-0000-0000-000000000003'
export const jobs={enqueue:[],recovery:[],cli:[]}
function fixture(){
 let fingerprint=null,body=null
 const pool={release(){},async connect(){return pool},async query(text,values=[]){
  if(text.startsWith('INSERT INTO background_jobs(')){fingerprint=values[3];body=values[4]}
  if(text.startsWith('INSERT INTO background_job_recoveries')){fingerprint=values[2];return {rows:[{request_id:requestId}]}}
  if(text.startsWith('SELECT id,input_hash'))return {rows:[{id,input_hash:fingerprint}]}
  if(text.startsWith('SELECT state,generation'))return {rows:[{state:'dead',generation:0}]}
  if(text.includes('RETURNING key'))return {rows:[{key:'step'}]}
  return {rows:[]}
 }}
 return {store:jobStore(pool),captured:()=>({fingerprint,body})}
}
const base={kind:'fixture-v1',scope:'workspace:x',identity:'daily',input:{z:1,a:'😀'},scheduledAt:'2020-01-01T00:00:00.000Z',maxAttempts:5}
const inputs=[base,...['','a','a'.repeat(200),'a'.repeat(201),'a\n','a\r','a\r\n','a\u2028','with space','é','a/b','a_b.C:d-3'].flatMap(v=>['kind','scope','identity'].map(k=>({...base,[k]:v}))),...[0,1,20,21,-1,1.1].map(maxAttempts=>({...base,maxAttempts})),...[null,{},[],{a:1,z:'😀'},'a'.repeat(16382),'a'.repeat(16383),'é'.repeat(8191),'é'.repeat(8192)].map(input=>({...base,input}))]
for(const input of inputs){const f=fixture();let code=null;try{await f.store.enqueue({...input,scheduledAt:new Date(input.scheduledAt)})}catch(e){code=e.code??'JOB_FAILED'}jobs.enqueue.push({input,code,...f.captured()})}
const recovery={requestId,jobId:id,operatorId,generation:0,reason:'code-fixed',action:'replay'}
const resolve={...recovery,action:'resolve',reason:'provider-confirmed',step:'send',outcome:'completed',quiesced:true,evidence:'FOR-64'}
for(const input of [recovery,resolve,{...resolve,outcome:'retry-safe'},...['requestId','jobId','operatorId'].flatMap(k=>['bad',id.toUpperCase(),id+'\n'].map(v=>({...recovery,[k]:v}))),...[-1,0.5,'0',null].map(generation=>({...recovery,generation})),...['bad','dependency-restored','provider-confirmed'].map(reason=>({...recovery,reason})),...['action','reason','step','outcome','quiesced','evidence'].map(k=>({...resolve,[k]:k==='quiesced'?false:'bad value'})),{...recovery,extra:'preserved-in-hash'}]){
 const f=fixture();let code=null;try{await f.store.recover(input)}catch(e){code=e.code??'JOB_FAILED'}jobs.recovery.push({input,code,fingerprint:f.captured().fingerprint})
}
const argv=['replay',id,'--generation','0','--request',requestId,'--operator',operatorId,'--reason','code-fixed']
const cliCases=[argv,['resolve',id,...argv.slice(2),'--step','send','--outcome','completed','--quiesced','true','--evidence','FOR-64'],...['','0x0','0b0','0o0',' 0 ','0.0','-1','Infinity','no'].map(n=>argv.map((v,i)=>i===3?n:v)),argv.slice(0,3),[...argv,'--unknown','x'],[...argv,'--reason','code-fixed'],[...argv,'--step','x'],argv.filter((_,i)=>i!==2&&i!==3)]
for(const args of cliCases){let input=null,code=null;try{await jobCommand({async recover(value){input=value;return {replayed:false}}},args)}catch(e){code=e.code??'JOB_FAILED'}jobs.cli.push({args,input,code})}
