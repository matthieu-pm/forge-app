import {readFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {createHmac,createHash} from 'node:crypto'
import {mock} from 'bun:test'
mock.module('@tanstack/react-start/server-only',()=>({}))
const {z}=await import('../apps/forge/node_modules/zod/index.js')
const {UPLOAD_LIMITS,uploadTargetSchema,uploadInputSchema,readyUploadSchema}=await import('../apps/forge/src/application/files/upload-contract.ts')
const {fileTargetSchema}=await import('../apps/forge/src/application/files/file-delivery-contract.ts')
const {assertFileReference}=await import('../apps/forge/src/application/files/blob-store.ts')
const {mintFileGrant,verifyFileGrant}=await import('../apps/forge/src/application/files/file-grant.server.ts')
const source=readFileSync(new URL('../apps/forge/src/application/files/resource-file-service.server.ts',import.meta.url),'utf8')
const code=source.slice(source.indexOf('const resourceSchema'),source.indexOf('function publicRecord'))
const {resourceSchema,inputSchema}=new Function('z',new Bun.Transpiler({loader:'ts'}).transformSync(code)+';return {resourceSchema,inputSchema}')(z)
const uuid='abcdefab-0000-4000-8000-000000000001',date='2026-01-01T00:00:00.000Z'
const actor={userId:'user',workspaceId:'workspace',workspaceRole:'member',authentication:{kind:'session',sessionId:'session'},scopes:null}
export const fileContracts={schemas:[],references:[],grants:[],verification:[]}
function add(kind,schema,input){const result=schema.safeParse(input);fileContracts.schemas.push({kind,input,valid:result.success,...(result.success?{expected:result.data}:{})})}
const base={commandKey:uuid,target:{kind:'issue',id:uuid},name:' original.txt ',contentType:' TEXT/PLAIN ',sizeBytes:5,checksum:'a'.repeat(64)}
const changes=[{}, {extra:true},{commandKey:'legacy'},{commandKey:uuid.toUpperCase()},{checksum:'a'.repeat(64)+'\n'},{checksum:'A'.repeat(64)},{checksum:'invalid'},...['','a/b','a\\b','a\nb','a\0b','a\x7fb','a\x08b','☃'.repeat(200),'😀'.repeat(201),'\ufeff name \ufeff'].map(name=>({name})),...['text/plain','text/plain\n','text/html','application/json','image/svg+xml','bad','', 'image/PnG','image/png; charset=utf-8'].map(contentType=>({contentType})),...[0,-1,1.1,1,100_000_000,100_000_001,9007199254740992].map(sizeBytes=>({sizeBytes}))]
for(const patch of changes)add('upload',uploadInputSchema,{...base,...patch})
for(const kind of ['agent','issue','document','project','resources','attachments','artifacts','unknown'])for(const patch of [{},{id:uuid},{id:uuid.toUpperCase()},{id:uuid.replaceAll('-','')},{id:'legacy'},{id:uuid,extra:true}]){
 const v={kind,...patch};add('target',uploadTargetSchema,v);add('resource',resourceSchema,v);add('delivery',fileTargetSchema,v)
}
const ready={id:uuid,name:'file',contentType:'anything',sizeBytes:1,checksum:'a'.repeat(64),createdAt:date,expiresAt:null}
for(const patch of [{},{extra:true},{id:'bad'},{sizeBytes:0},{sizeBytes:1.5},{sizeBytes:100_000_001},{createdAt:'bad'},{createdAt:'2026-01-01T00:00:00+00:00'},{expiresAt:date},{checksum:'a'.repeat(64)+'\n'}])add('ready',readyUploadSchema,{...ready,...patch})
for(const patch of changes)add('resource-input',inputSchema,{name:base.name,contentType:'text/plain',...patch})
for(const input of [`files/${uuid}`,`attachments/${uuid}`,`${uuid}/${uuid}`,`files/${uuid}\n`,`files/${uuid.toUpperCase()}`,`files/${uuid}/../other`,'https://example.test/file',`files/${uuid}/`,`../files/${uuid}`,`files/00000000-0000-0000-0000-000000000000`]){let valid=true;try{assertFileReference(input)}catch{valid=false}fileContracts.references.push({input,valid})}
const secret='reference-file-grant-key-not-for-production'
const saved=process.env.FORGE_AGENT_ARTIFACT_SECRET
process.env.FORGE_AGENT_ARTIFACT_SECRET=secret
try{
 for(const kind of ['resources','artifacts','attachments'])for(const purpose of ['download','preview']){
  const target={kind,id:uuid},now=1700000000,token=await mintFileGrant(actor,target,purpose,new Date(now*1000))
  fileContracts.grants.push({actor,target,purpose,secret,now,token,mint:true,valid:true})
  const payload=JSON.parse(Buffer.from(token.split('.')[1],'base64url'))
  const patches=[{}, {sub:'other'},{workspaceId:'other'},{kind:'resources'},{fileId:'other'},{purpose:'preview'},{iss:'other'},{aud:'other'},{aud:['other','forge-private-file']},{iat:now+1},{iat:now-301,exp:now+1},{iat:now-300,exp:now+1},{iat:now-1,exp:now+299},{iat:now-0.5,exp:now+299.5},{iat:null},{iat:'1700000000'},{exp:now},{exp:now+301},{exp:null},{nbf:now+1},{nbf:now},{nbf:'bad'}]
  for(const patch of patches){const body=Buffer.from(JSON.stringify({...payload,...patch})).toString('base64url');const signed=token.split('.')[0]+'.'+body;const value=signed+'.'+createHmac('sha256',secret).update(signed).digest('base64url');let valid=true;try{await verifyFileGrant(value,actor,target,purpose,new Date(now*1000))}catch{valid=false}fileContracts.grants.push({actor,target,purpose,secret,now,token:value,mint:false,valid})}
  for(const offset of [-1,299,300,301]){let valid=true;try{await verifyFileGrant(token,actor,target,purpose,new Date((now+offset)*1000))}catch{valid=false}fileContracts.grants.push({actor,target,purpose,secret,now:now+offset,token,mint:false,valid})}
 }
}finally{if(saved===undefined)delete process.env.FORGE_AGENT_ARTIFACT_SECRET;else process.env.FORGE_AGENT_ARTIFACT_SECRET=saved}
const inputs=[['plain text café','text/plain'],['\ufeff{"bom":true}','application/json'],['{"message":"café😀"}','application/json'],['1e999','application/json'],['"\\ud800"','application/json'],['[1,]','application/json'],['not json','application/json'],['{"a":1} trailing','application/json'],['%PDF-1.7\nhello','application/pdf'],['%PDF-1.7\nhello','image/png'],['<html>safe text</html>','text/html'],['<svg></svg>','image/svg+xml'],['plain','application/octet-stream'],['a\0b','text/plain'],[Buffer.from([0,255,0,1]),'image/png'],[Buffer.from([0xc3]),'text/plain']]
const verificationInputs=[]
for(const [data,contentType] of inputs)for(const chunkSize of [1,3,1000])for(const change of ['none','size','checksum']){
 const bytes=Buffer.from(data),checksum=createHash('sha256').update(bytes).digest('hex');const input={...base,contentType,sizeBytes:change==='size'?bytes.length+1:bytes.length,checksum:change==='checksum'?'0'.repeat(64):checksum}
 verificationInputs.push({input,bytes:bytes.toString('base64'),chunkSize})
}
// Run the owning service in Node, the server/test runtime. Bun 1.3.5's
// streaming TextDecoder mishandles a BOM split across one-byte chunks.
const transpiler=new Bun.Transpiler({loader:'ts'})
function implementation(file,start){
 const text=readFileSync(new URL('../apps/forge/src/application/files/'+file,import.meta.url),'utf8')
 return transpiler.transformSync(text.slice(text.indexOf(start))).replaceAll('export ', '')
}
const script=`
import {createHash} from 'node:crypto';
import {fileTypeFromBuffer} from ${JSON.stringify(new URL('../apps/forge/node_modules/file-type/source/index.js',import.meta.url).href)};
const UPLOAD_LIMITS=${JSON.stringify(UPLOAD_LIMITS)};
${implementation('upload-contract.ts','export class UploadError')}
${implementation('upload-type.server.ts','export async function inspectUploadType')}
${implementation('upload-service.server.ts','export class UploadService')}
const uuid=${JSON.stringify(uuid)}, date=${JSON.stringify(date)}, actor=${JSON.stringify(actor)};
const results=[];
for(const item of ${JSON.stringify(verificationInputs)}){
 const {input,chunkSize}=item,bytes=Buffer.from(item.bytes,'base64');
 const intent={...input,id:uuid,workspaceId:actor.workspaceId,userId:actor.userId,storageReference:'files/'+uuid,state:'pending',createdAt:new Date(date),expiresAt:new Date(date),tokenExpiresAt:null,attempts:[],result:null,rejectionReason:null,cleanedAt:null}
 let rejection=null,published=null,cancelled=0
 const store={prepare:async()=>intent,publish:async(_a,_id,v)=>{published=v;return v},reject:async(_a,_id,message)=>{rejection=message}}
 const transport={read:async()=>{let i=0;return new ReadableStream({pull(c){if(i>=bytes.length){c.close();return}const end=Math.min(i+chunkSize,bytes.length);c.enqueue(bytes.subarray(i,end));i=end},cancel(){cancelled++}})}}
 let output=null,error=null;try{output=await new UploadService(store,transport).finalize(actor,uuid)}catch(e){error={code:e.code,message:e.message}}
 let detected=null;try{detected=(await fileTypeFromBuffer(bytes.subarray(0,1048576)))?.mime??null}catch{}
 results.push({input,bytes:bytes.toString('base64'),chunkSize,detected,output,error,rejection,published})
}
process.stdout.write(JSON.stringify(results));
`
const reference=spawnSync('node',['--input-type=module','-'],{input:script,encoding:'utf8',maxBuffer:8*1024*1024})
if(reference.error||reference.status!==0)throw new Error(reference.error?.message??reference.stderr)
fileContracts.verification=JSON.parse(reference.stdout)
