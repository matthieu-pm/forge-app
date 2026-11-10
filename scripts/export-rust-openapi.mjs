import {createRequire} from "node:module"
import {pathToFileURL} from "node:url"
import {readFileSync,writeFileSync} from "node:fs"
import {publicApiContract} from "../apps/forge/src/api/v1/contract.ts"
const requireFromApp=createRequire(new URL("../apps/forge/package.json",import.meta.url))
const {OpenAPIGenerator}=await import(pathToFileURL(requireFromApp.resolve("@orpc/openapi")))
const {ZodToJsonSchemaConverter}=await import(pathToFileURL(requireFromApp.resolve("@orpc/zod/zod4")))
const {OpenAPIReferencePlugin}=await import(pathToFileURL(requireFromApp.resolve("@orpc/openapi/plugins")))
const generator=new OpenAPIGenerator({schemaConverters:[new ZodToJsonSchemaConverter()]})
const document=await generator.generate(publicApiContract,{
  info:{title:"Forge API",version:"1.0.0",description:"Programmatic access to Forge workspaces and their resources."},
  servers:[{url:"/api/v1"}],security:[{bearerAuth:[]}],
  components:{securitySchemes:{bearerAuth:{type:"http",scheme:"bearer",bearerFormat:"Forge API key"}}},
})
const output=JSON.stringify(document,null,2)+"\n"
const destination=new URL("../rust/crates/forge-server/templates/openapi.json",import.meta.url)
const plugin=new OpenAPIReferencePlugin()
const html=plugin.renderDocsHtml("/api/v1/openapi.json","Forge API Reference","",plugin.docsScriptUrl,undefined,document,plugin.docsProvider,undefined).replace(/[ \t]+$/gm,"").trim()+"\n"
const htmlDestination=new URL("../rust/crates/forge-server/templates/api-reference.html",import.meta.url)
if(process.argv.includes("--check")){
  if(readFileSync(destination,"utf8")!==output){console.error("Reference OpenAPI contract changed. Review and regenerate the Rust asset.");process.exitCode=1}
  if(readFileSync(htmlDestination,"utf8")!==html){console.error("Reference API documentation changed.");process.exitCode=1}
}else{writeFileSync(destination,output);writeFileSync(htmlDestination,html)}
