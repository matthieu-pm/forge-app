import { randomBytes } from "node:crypto"
import { chmod, lstat, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

const workspace = resolve(import.meta.dirname, "../../..")
const target = resolve(workspace, ".env.local")
if (!target.startsWith(`${workspace}/`)) {
  throw new Error("The local env target must stay inside the workspace.")
}

const stat = await lstat(target).catch(() => null)
if (stat?.isSymbolicLink()) {
  throw new Error("Refusing to write secrets through a symbolic link.")
}

const current = await readFile(target, "utf8").catch(() => "")
const values = new Map(
  current
    .split(/\r?\n/)
    .map((line) => {
      const separator = line.indexOf("=")
      return separator > 0
        ? ([line.slice(0, separator), line.slice(separator + 1)] as const)
        : null
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry))
)

const generated = new Map<string, string>()
const ensure = (name: string, encoding: "base64" | "base64url") => {
  if (values.get(name)?.trim()) return
  const value = randomBytes(32).toString(encoding)
  values.set(name, value)
  generated.set(name, value)
}

ensure("FORGE_AGENT_CHANNEL_SECRET", "base64url")
ensure("FORGE_AGENT_CAPABILITY_SECRET", "base64url")
ensure("FORGE_AGENT_LOCAL_INGEST_SECRET", "base64url")
ensure("FORGE_AGENT_MODEL_ACCESS_SECRET", "base64url")
ensure("FORGE_MODEL_CREDENTIAL_KEK", "base64")

if (!values.get("EVE_AGENT_RUNTIME_URL")?.trim()) {
  values.set("EVE_AGENT_RUNTIME_URL", "http://127.0.0.1:2000")
  generated.set("EVE_AGENT_RUNTIME_URL", "http://127.0.0.1:2000")
}

if (generated.size > 0) {
  const additions = [...generated]
    .map(([name, value]) => `${name}=${value}`)
    .join("\n")
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n"
  await writeFile(target, `${current}${separator}${additions}\n`, {
    encoding: "utf8",
    mode: 0o600,
  })
}
await chmod(target, 0o600)
process.stdout.write(
  generated.size > 0
    ? `Configured ${generated.size} local agent settings in .env.local.\n`
    : "Local agent settings are already configured.\n"
)
