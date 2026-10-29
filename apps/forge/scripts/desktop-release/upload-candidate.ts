import { readFile, readdir } from "node:fs/promises"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import { validateReleaseEnvironment } from "../lib/script-environment"


validateReleaseEnvironment("upload")

type CandidateArtifact = {
  platform: "darwin"
  architecture: "arm64" | "x64"
  kind: "dmg" | "zip"
  fileName: string
  objectKey: string
  sha256: string
  sizeBytes: number
  notarizationRef?: string
}

type CandidateMetadata = {
  version: string
  artifacts: Array<CandidateArtifact>
}

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

const packageRoot = resolve(import.meta.dirname, "../..")
const candidateRoot = resolve(packageRoot, "release-candidate/darwin")
const architectures = await readdir(candidateRoot)
const candidates = await Promise.all(
  architectures.map(async (architecture) => {
    const source = await readFile(
      resolve(candidateRoot, architecture, "metadata.json"),
      "utf8"
    )
    return JSON.parse(source) as CandidateMetadata
  })
)

const versions = new Set(candidates.map(({ version }) => version))
if (versions.size !== 1) {
  throw new Error("Every architecture must use the same Forge version.")
}
const version = [...versions][0]
const artifacts = candidates.flatMap(({ artifacts }) => artifacts)
const identities = new Set(
  artifacts.map(({ architecture, kind }) => `${architecture}:${kind}`)
)
if (identities.size !== 4) {
  throw new Error(
    "A release requires DMG and ZIP artifacts for both architectures."
  )
}

const endpoint =
  process.env.R2_ENDPOINT?.trim() ??
  `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`
const client = new S3Client({
  endpoint,
  region: "auto",
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
})
const bucket = required("R2_DESKTOP_RELEASE_BUCKET")

async function putImmutableObject({
  key,
  body,
  contentType,
  cacheControl = "public, max-age=31536000, immutable",
  metadata = {},
  expectedSha256,
}: {
  key: string
  body: Buffer | string
  contentType: string
  cacheControl?: string
  metadata?: Record<string, string>
  expectedSha256?: string
}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const sha256 =
    expectedSha256 ?? createHash("sha256").update(bytes).digest("hex")

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        CacheControl: cacheControl,
        ContentType: contentType,
        IfNoneMatch: "*",
        Metadata: { ...metadata, sha256 },
      })
    )
    return
  } catch (error) {
    const status =
      typeof error === "object" &&
      error !== null &&
      "$metadata" in error &&
      typeof error.$metadata === "object" &&
      error.$metadata !== null &&
      "httpStatusCode" in error.$metadata
        ? error.$metadata.httpStatusCode
        : undefined
    if (status !== 412) throw error
  }

  const existing = await client.send(
    new HeadObjectCommand({ Bucket: bucket, Key: key })
  )
  if (
    existing.ContentLength !== bytes.byteLength ||
    existing.Metadata?.sha256 !== sha256
  ) {
    throw new Error(
      `Immutable release object ${key} already exists with different content.`
    )
  }
}

for (const artifact of artifacts) {
  const localPath = resolve(
    candidateRoot,
    artifact.architecture,
    artifact.fileName
  )
  await putImmutableObject({
    key: artifact.objectKey,
    body: await readFile(localPath),
    contentType:
      artifact.kind === "dmg"
        ? "application/x-apple-diskimage"
        : "application/zip",
    expectedSha256: artifact.sha256,
    metadata: { architecture: artifact.architecture },
  })
}

for (const architecture of ["arm64", "x64"] as const) {
  const checksumKey = `desktop/v${version}/darwin/${architecture}/SHA256SUMS`
  await putImmutableObject({
    key: checksumKey,
    body: await readFile(resolve(candidateRoot, architecture, "SHA256SUMS")),
    contentType: "text/plain; charset=utf-8",
    metadata: { architecture },
  })
}

const manifest = {
  version,
  artifacts: artifacts.map(({ fileName: _fileName, ...artifact }) => artifact),
}
await putImmutableObject({
  key: `desktop/v${version}/manifest.json`,
  body: `${JSON.stringify(manifest, null, 2)}\n`,
  contentType: "application/json",
})

const apiOrigin = required("FORGE_RELEASE_API_ORIGIN")
const response = await fetch(
  new URL("/api/internal/desktop/releases", apiOrigin),
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${required("FORGE_DESKTOP_RELEASE_API_SECRET")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      version,
      releaseNotes: process.env.FORGE_DESKTOP_RELEASE_NOTES ?? "",
      artifacts: manifest.artifacts,
    }),
  }
)
if (!response.ok) {
  throw new Error(
    `Forge rejected desktop release registration (${response.status}).`
  )
}

console.log(`Uploaded and registered Forge v${version} as a draft.`)
