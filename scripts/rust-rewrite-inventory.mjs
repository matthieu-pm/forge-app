import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean)
  .sort()
const groups = new Map()
const routes = []
const migrations = []
for (const path of tracked) {
  if (path.startsWith("apps/forge/drizzle/") && path.endsWith(".sql")) {
    migrations.push({
      path,
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
    })
  }
  if (!/\.(ts|tsx|mjs|js)$/.test(path) || path.includes("/vendor/")) continue
  if (path.startsWith("apps/forge/src/routes/") && !/\.(test|spec)\./.test(path)) {
    routes.push(path)
  }
  let area
  if (path.startsWith("apps/forge/src/application/")) area = path.split("/").slice(0, 5).join("/")
  else if (path.startsWith("apps/forge/src/")) area = path.split("/").slice(0, 4).join("/")
  else if (path.startsWith("apps/forge/")) area = path.split("/").slice(0, 3).join("/")
  else if (/^(services|packages)\//.test(path)) area = path.split("/").slice(0, 2).join("/")
  else continue
  const group = groups.get(area) ?? { area, sourceFiles: 0, testFiles: 0 }
  group[/\.(test|spec)\./.test(path) ? "testFiles" : "sourceFiles"]++
  groups.set(area, group)
}

const output = JSON.stringify({
  description: "Reference source inventory; presence here does not mean Rust parity is implemented.",
  areas: [...groups.values()].sort((a, b) => a.area.localeCompare(b.area, "en")),
  routes,
  migrations,
}, null, 2) + "\n"
const destination = new URL("../rust/reference-inventory.json", import.meta.url)
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== output) {
    console.error("Reference inventory changed. Regenerate and review the rewrite scope.")
    process.exitCode = 1
  }
} else {
  writeFileSync(destination, output)
  console.log(`Recorded ${groups.size} source areas, ${routes.length} routes and ${migrations.length} migrations.`)
}
