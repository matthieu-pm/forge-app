import {gunzipSync} from 'node:zlib'
import {Sandbox} from '../services/agent-runtime/node_modules/eve/dist/src/compiled/@vercel/sandbox/index.js'
const id='sbx_fixture',name='forge-rust-fixture',now=1793491200000
const session={id,memory:2048,vcpus:1,region:'iad1',runtime:'node24',timeout:1800000,status:'running',requestedAt:now,createdAt:now,updatedAt:now,cwd:'/vercel/sandbox',networkPolicy:{mode:'deny-all'}}
const sandbox={name,persistent:false,createdAt:now,updatedAt:now,currentSessionId:id,status:'running',networkPolicy:{mode:'deny-all'}}
const command={id:'cmd_fixture',name:'bash',args:['-lc','echo fixture'],cwd:'/workspace',sessionId:id,exitCode:null,startedAt:now}
const requests=[]
const fetch=async(input,init)=>{
 const url=new URL(input),headers=new Headers(init.headers),request={path:url.pathname,query:Object.fromEntries(url.searchParams),method:init.method,headers:Object.fromEntries(['authorization','content-type','x-cwd'].filter(k=>headers.has(k)).map(k=>[k,headers.get(k)]))}
 if(headers.get('content-type')==='application/gzip'){
   const tar=gunzipSync(init.body),text=(a,b)=>tar.subarray(a,b).toString().split('\0')[0],size=parseInt(text(124,136),8)
   request.archive={path:text(0,100),mode:parseInt(text(100,108),8),content:tar.subarray(512,512+size).toString()}
 }else if(init.body)request.body=JSON.parse(init.body)
 requests.push(request)
 if(url.pathname==='/api/v2/sandboxes')return Response.json({sandbox,session,routes:[]})
 if(url.pathname.endsWith('/network-policy'))return Response.json({session})
 if(url.pathname.endsWith('/cmd'))return new Response([JSON.stringify({command}),JSON.stringify({stream:'stdout',data:'fixture 😀\n'}),JSON.stringify({stream:'stderr',data:'note\n'}),JSON.stringify({command:{...command,exitCode:0}})].join('\n')+'\n',{headers:{'content-type':'application/x-ndjson'}})
 if(url.pathname.endsWith('/fs/write'))return Response.json({})
 if(url.pathname.endsWith('/stop'))return Response.json({session:{...session,status:'stopped'}})
 throw new Error('Unexpected SDK fixture request '+url.pathname)
}
const instance=await Sandbox.create({teamId:'team_fixture',projectId:'prj_fixture',token:'public-sandbox-fixture-token',name,persistent:false,image:'vercel/eve:latest',timeout:1800000,ports:[],networkPolicy:'deny-all',env:{},fetch})
await instance.updateNetworkPolicy('deny-all')
const result=await instance.runCommand({cmd:'bash',args:['-lc','echo fixture'],cwd:'/workspace',env:{}})
const output={stdout:await result.stdout(),stderr:await result.stderr(),exitCode:result.exitCode}
await instance.writeFiles([{path:'/workspace/programs/fixture/input.json',content:Buffer.from('{"value":"😀"}')}])
await instance.fs.rm('/workspace/programs/fixture',{recursive:true,force:true})
await instance.stop()
export const sandboxProtocol={requests,output}
