import { createHash, randomUUID } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const serviceRoot = resolve(import.meta.dirname, "..")
const policyRoot = resolve(serviceRoot, "vendor/eve")
const require = createRequire(resolve(serviceRoot, "package.json"))
const digest = (value) => createHash("sha256").update(value).digest("hex")

// A verified, atomic replacement avoids Bun's patch packer dropping EVE's
// shipped nested node_modules. Never search/replace an unknown library version.
export async function applyDiagnosticPolicy({ optional = false } = {}) {
  let packageRoot
  try {
    packageRoot = dirname(require.resolve("eve/package.json"))
  } catch (error) {
    if (optional && error.code === "MODULE_NOT_FOUND") return
    throw error
  }
  const installed = JSON.parse(
    await readFile(resolve(packageRoot, "package.json"), "utf8")
  )
  const policy = JSON.parse(
    await readFile(resolve(policyRoot, "policy.json"), "utf8")
  )
  if (installed.version !== policy.version)
    throw new Error(
      "EVE diagnostic policy requires an explicitly reviewed dependency version."
    )
  for (const file of policy.files) {
    const target = resolve(packageRoot, file.path)
    const replacement = await readFile(resolve(policyRoot, file.replacement))
    const current = digest(await readFile(target))
    if (
      digest(replacement) !== file.replacementSha256 ||
      (current !== file.originalSha256 && current !== file.replacementSha256)
    ) {
      throw new Error(
        "EVE diagnostic policy integrity check failed. Review the pinned dependency and replacement sources."
      )
    }
    if (current === file.replacementSha256) continue
    // Rename avoids modifying any inode shared with a package-manager cache.
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, replacement)
    await rename(temporary, target)
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await applyDiagnosticPolicy({
    optional: process.argv.includes("--if-installed"),
  })
}
