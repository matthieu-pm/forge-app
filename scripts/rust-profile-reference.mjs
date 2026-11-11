import {readFileSync} from 'node:fs'
import {profileCommandSchema,profileValuesSchema,MAX_AVATAR_BYTES} from '../apps/forge/src/lib/profile-contract.ts'
import {fileTypeFromBuffer} from '../apps/forge/node_modules/file-type/source/index.js'
// Evaluate the owning validator without importing database/environment adapters.
const source=readFileSync(new URL('../apps/forge/src/application/profiles/profiles.server.ts',import.meta.url),'utf8')
const body=source.slice(source.indexOf('class ProfileValidationError'),source.indexOf('export async function readProfile')).replace('export async function','async function')
const code=new Bun.Transpiler({loader:'ts'}).transformSync(body)
const validate=new Function('Buffer','MAX_AVATAR_BYTES','fileTypeFromBuffer',code+'\nreturn validateProfileAvatar;')(Buffer,MAX_AVATAR_BYTES,fileTypeFromBuffer)
const base={commandKey:'00000000-0000-4000-8000-000000000001',sessionId:'session',expectedWorkspaceId:'workspace',expectedRevision:'2026-11-03T00:00:00.000Z',patch:{title:' Engineer '}}
export const profiles={contracts:[],avatars:[]}
function record(kind,input){const r=(kind==='command'?profileCommandSchema:profileValuesSchema).safeParse(input);profiles.contracts.push({kind,input,valid:r.success,...(r.success?{value:r.data}:{})})}
for(const patch of [{},{name:' Alice ',title:' Engineer ',username:null,image:null},{name:''},{name:'x'.repeat(80)},{name:'x'.repeat(81)},{name:'😀'.repeat(80)},{name:'😀'.repeat(81)},{title:''},{title:null},{title:'\t multi\nline\r title '},...Array.from({length:33},(_,n)=>({title:'a'+String.fromCharCode(n)+'b'})),{title:'a\x7fb'},{username:' lower-case_1 '},{username:''},{username:'Upper'},{username:'x'.repeat(32)},{username:'x'.repeat(33)},{username:null},{image:null},{image:'https://example.test/a.png'},{image:'data:image/svg+xml;base64,PHN2Zz4='},{image:'data:image/png;base64,SGVsbG8='},{title:'safe',userId:'other'},{title:'safe',emailVerified:true}])record('command',{...base,patch})
for(const key of Object.keys(base)){const missing={...base};delete missing[key];record('command',missing);for(const value of [null,[],{},true,0,''])record('command',{...base,[key]:value})}
for(const revision of ['2026-11-03T00:00Z','2026-11-03T00:00:00Z','2026-11-03T00:00:00.123456789Z','2026-02-29T00:00:00Z','2024-02-29T00:00:00Z','2026-11-03T00:00:00+00:00'])record('command',{...base,expectedRevision:revision})
for(const input of [null,{},[],{name:'Alice',title:'',username:null,image:null},{name:'Alice',title:'',username:null,image:null,role:'owner'}])record('values',input)
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1cAAAAASUVORK5CYII='
for(const image of ['data:image/png;base64,'+png,'data:image/jpeg;base64,'+png,'data:image/png;base64,SGVsbG8=','data:image/png;base64,SGVsbG8','data:image/png;base64,SGVsbG9=','data:image/png;base64,A===','data:image/png;base64,','https://example.test/a.png','data:image/svg+xml;base64,PHN2Zz4=',...['/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==','UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vv9UAA='].map((v,n)=>`data:image/${n?'webp':'jpeg'};base64,${v}`)]){
 let error=null;try{await validate(image)}catch(e){error=e.message}profiles.avatars.push({image,error})
}
for(const bytes of [MAX_AVATAR_BYTES-1,MAX_AVATAR_BYTES,MAX_AVATAR_BYTES+1]){const image='data:image/png;base64,'+Buffer.concat([Buffer.from(png,'base64'),Buffer.alloc(bytes-Buffer.from(png,'base64').length)]).toString('base64');let error=null;try{await validate(image)}catch(e){error=e.message}profiles.avatars.push({image:'data:image/png;base64,'+png,resize:bytes,error})}
