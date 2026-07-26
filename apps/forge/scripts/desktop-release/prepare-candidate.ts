import { createHash } from "node:crypto"
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises"
import { basename, extname, join, resolve } from "node:path"
import { execa } from "execa"

type Architecture = "arm64" | "x64"

function argument(name: string) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function filesUnder(directory: string): Promise<Array<string>> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? filesUnder(path) : [path]
    })
  )
  return files.flat()
}

async function sha256(path: string) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

const architecture = argument("--arch")
if (architecture !== "arm64" && architecture !== "x64") {
  throw new Error("--arch must be arm64 or x64.")
}

const packageRoot = resolve(import.meta.dirname, "../..")
const packageJson = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8")
) as { version: string }
const version = packageJson.version
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("The Forge package version must be semantic.")
}

const packagedInfoPlist = resolve(
  packageRoot,
  "out",
  `Forge-darwin-${architecture}`,
  "Forge.app",
  "Contents",
  "Info.plist"
)
const { stdout: packagedVersion } = await execa("plutil", [
  "-extract",
  "CFBundleShortVersionString",
  "raw",
  "-o",
  "-",
  packagedInfoPlist,
])
if (packagedVersion.trim() !== version) {
  throw new Error(
    `The packaged Forge version ${packagedVersion.trim()} does not match ${version}.`
  )
}

const outputFiles = await filesUnder(resolve(packageRoot, "out/make"))
const candidateDirectory = resolve(
  packageRoot,
  "release-candidate/darwin",
  architecture
)
await mkdir(candidateDirectory, { recursive: true })

const artifacts = []
for (const kind of ["dmg", "zip"] as const) {
  const matches = outputFiles.filter(
    (path) => extname(path).toLowerCase() === `.${kind}`
  )
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${kind.toUpperCase()} for ${architecture}, found ${matches.length}: ${matches
        .map((path) => basename(path))
        .join(", ")}`
    )
  }

  const source = matches[0]
  const fileName = `Forge-${version}-${architecture}.${kind}`
  const destination = resolve(candidateDirectory, fileName)
  await copyFile(source, destination)
  const fileStat = await stat(destination)
  const checksum = await sha256(destination)
  const objectKey = `desktop/v${version}/darwin/${architecture}/${fileName}`

  artifacts.push({
    platform: "darwin" as const,
    architecture: architecture as Architecture,
    kind,
    fileName,
    objectKey,
    sha256: checksum,
    sizeBytes: fileStat.size,
    notarizationRef:
      process.env.FORGE_NOTARIZATION_REF ?? process.env.CI_JOB_URL ?? undefined,
  })
}

await writeFile(
  resolve(candidateDirectory, "metadata.json"),
  `${JSON.stringify({ version, artifacts }, null, 2)}\n`
)
await writeFile(
  resolve(candidateDirectory, "SHA256SUMS"),
  `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.fileName}`).join("\n")}\n`
)

console.log(`Prepared Forge v${version} for ${architecture}.`)
