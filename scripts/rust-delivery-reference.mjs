import {mock} from 'bun:test'
mock.module('@tanstack/react-start/server-only',()=>({}))
const {previewFileResponse,downloadFileResponse}=await import('../apps/forge/src/application/files/file-response.server.ts')
const {inspectFileStorage}=await import('../packages/environment/file-storage.ts')
const {generateClientTokenFromReadWriteToken}=await import('../apps/forge/node_modules/@vercel/blob/dist/client.js')
const {fileTypeFromBuffer}=await import('../apps/forge/node_modules/file-type/source/index.js')
export const fileDelivery={storage:[],tokens:[],rendering:[],detection:[]}
for(const base of [{},{NODE_ENV:'production'},{VERCEL:'1'},{VERCEL_ENV:'preview'},{FORGE_ENVIRONMENT:'development'},{FORGE_ENVIRONMENT:'staging'}])for(const patch of [{},{FORGE_AGENT_BLOB_ADAPTER:'local'},{FORGE_AGENT_BLOB_ADAPTER:'vercel-private'},{FORGE_AGENT_BLOB_ADAPTER:'s3'}])for(const credentials of [{},{BLOB_STORE_ID:'store_test',BLOB_READ_WRITE_TOKEN:'vercel_blob_rw_test_key'},{BLOB_STORE_ID:'store_other',BLOB_READ_WRITE_TOKEN:'vercel_blob_rw_test_key'}]){
 const input={...base,...patch,...credentials};const r=inspectFileStorage(input);fileDelivery.storage.push({input,valid:r.issues.length===0,adapter:r.adapter})
}
for(const sizeBytes of [1,10_000_000,100_000_000]){
 const secret='vercel_blob_rw_fixture_public-reference-test-key',store='fixture',reference='files/00000000-0000-4000-8000-000000000001',validUntil=1700000000000
 const token=await generateClientTokenFromReadWriteToken({token:secret,pathname:`forge/${reference}`,validUntil,maximumSizeInBytes:sizeBytes,allowedContentTypes:['application/octet-stream'],addRandomSuffix:false,allowOverwrite:false})
 fileDelivery.tokens.push({secret,store,reference,validUntil,sizeBytes,token})
}
const html=[
 '<h1>Readable</h1><script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://evil.test"><a href="https://evil.test">link</a><form action="/api/auth"><input></form><iframe srcdoc="<script>alert(1)</script>"></iframe><style>body{background:url(https://evil.test)}</style><img src="https://evil.test"><p style="background:url(https://evil.test)" onclick="alert(1)">safe</p>',
 '<p>first<p>second<br>line<hr><strong>bold</strong>',
 '<table><tr><td>A</td><td>B</td></tr></table>',
 '<p>&lt;script&gt; &amp; "quoted" café 😀</p>',
 '<xmp><img onerror="alert(1)"></xmp><textarea><svg onload="a()"></textarea><option>hidden</option><b>safe</b>',
 '<div>'.repeat(40)+'deep'+'</div>'.repeat(40),
 '<svg><textarea><img src=x onerror=a()></textarea></svg><p>safe</p>',
 '<iframe><script>a()</script><b>fallback</b></iframe>',
 '<ul><li>one<li>two</ul>',
 '<p>left<div>block</div>right',
]
const svg=[
 '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><script>alert(1)</script><foreignObject><iframe src="https://evil.test"/></foreignObject><use href="https://evil.test/a.svg#x"/><rect width="30" height="30" fill="url(https://evil.test)" onload="alert(1)"/></svg>',
 '<svg viewBox="0 0 10 10"><title>A &amp; B</title><path d="M0 0 L1 1" stroke="red" fill="#fff"/><circle cx="5" cy="5" r="4" fill="rgb(0, 0, 0)"/></svg>',
 '<svg><rect fill="url(#paint)" stroke="javascript:alert(1)"/><text>Text &lt;safe&gt;</text></svg>',
]
const entries=[...html.map(text=>['x.html','text/html',Buffer.from(text)]),...svg.map(text=>['x.svg','image/svg+xml',Buffer.from(text)]),['x.txt','text/plain',Buffer.from('<script>alert(1)</script> & "hi"')],['bom.txt','text/plain',Buffer.from('\ufeffbom')],['x.html','text/plain',Buffer.from('<b>legacy</b>')],['x.svg','text/plain',Buffer.from('<svg><text>legacy</text></svg>')],...['application/json','application/pdf','application/octet-stream','text/plain'].flatMap(mime=>[['x',mime,Buffer.from('plain')],['x',mime,Buffer.from([0xff])],['x',mime,Buffer.from('a\0b')]]),['x.png','image/png',Buffer.from([1,2,3])]]
for(const [name,contentType,bytes] of entries)for(const purpose of ['preview','download']){
 let body=null,headers=null,error=null
 try{const r=purpose==='preview'?previewFileResponse({name,contentType},bytes):downloadFileResponse({name},bytes);headers=Object.fromEntries(r.headers);body=Buffer.from(await r.arrayBuffer()).toString('base64')}catch(e){error=e.code??'FILE_UNAVAILABLE'}
 fileDelivery.rendering.push({name,contentType,bytes:bytes.toString('base64'),purpose,body,headers,error})
}
for(const name of ["a'\r\nX-Header:☃.html",'😀'.repeat(101),'a'.repeat(199)+'😀','"\\/;!~()*%é.txt']){
 let headers=null,error=null;try{headers=Object.fromEntries(downloadFileResponse({name},new Uint8Array([1])).headers)}catch{error='FILE_UNAVAILABLE'}
 fileDelivery.rendering.push({name,contentType:'application/octet-stream',bytes:'AQ==',purpose:'download',body:error?null:'AQ==',headers,error})
}
const signatures=[Buffer.from('%PDF-1.7\nhello'),Buffer.from('GIF89a\x01\0\x01\0\0\0\0','binary'),Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex'),Buffer.from('52494646240000005745425056503820180000003001009d012a0100010002003425a400037000fefbfd5000','hex'),Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9','hex'),Buffer.from('504b030400000000000000000000000000000000000000000000000000000000','hex'),Buffer.from('hello'),Buffer.from([0,255,1,2])]
for(const full of signatures)for(const length of [...new Set([1,3,4,8,12,full.length].filter(n=>n<=full.length))]){
 const bytes=full.subarray(0,length);let detected=null;try{detected=(await fileTypeFromBuffer(bytes))?.mime??null}catch{}
 fileDelivery.detection.push({bytes:bytes.toString('base64'),detected})
}

for(const text of ['A'.repeat(1024),'<h1>Readable</h1><script>parent.pwned=true</script>','<html>safe</html>','<svg></svg>','#!/bin/sh\necho hi','<?xml version="1.0"?><a/>',' <?xml version="1.0"?><a/>','\ufeff<?xml version="1.0"?><a/>','<?XML version="1.0"?><a/>']){
 const bytes=Buffer.from(text);let detected=null;try{detected=(await fileTypeFromBuffer(bytes))?.mime??null}catch{}
 fileDelivery.detection.push({bytes:bytes.toString('base64'),detected})
}
