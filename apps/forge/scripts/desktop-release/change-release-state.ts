import { createHash } from "node:crypto"
import { validateReleaseEnvironment } from "../lib/script-environment"

type ManifestArtifact = {
  architecture: "arm64" | "x64"
  kind: "dmg" | "zip"
  objectKey: string
  sha256: string
  sizeBytes: number
}

type ReleaseManifest = {
  version: string
  artifacts: Array<ManifestArtifact>
}

function required(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function semanticVersion(value: string, name: string) {
  const version = value.startsWith("v") ? value.slice(1) : value
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${name} must be a semantic version.`)
  }
  return version
}

function releaseApiUrl(version: string, action: "pause" | "promote") {
  return new URL(
    `/api/internal/desktop/releases/${version}/${action}`,
    required("FORGE_RELEASE_API_ORIGIN")
  )
}

async function changeReleaseState(
  version: string,
  action: "pause" | "promote"
) {
  const response = await fetch(releaseApiUrl(version, action), {
    method: "POST",
    headers: {
      authorization: `Bearer ${required("FORGE_DESKTOP_RELEASE_API_SECRET")}`,
    },
  })
  if (!response.ok) {
    throw new Error(
      `Forge rejected desktop release ${action} (${response.status}).`
    )
  }
}

function isManifest(value: unknown): value is ReleaseManifest {
  if (!value || typeof value !== "object") return false
  const record = value as Partial<ReleaseManifest>
  return (
    typeof record.version === "string" &&
    Array.isArray(record.artifacts) &&
    record.artifacts.every(
      (artifact) =>
        artifact &&
        typeof artifact === "object" &&
        (artifact.architecture === "arm64" ||
          artifact.architecture === "x64") &&
        (artifact.kind === "dmg" || artifact.kind === "zip") &&
        typeof artifact.objectKey === "string" &&
        typeof artifact.sha256 === "string" &&
        typeof artifact.sizeBytes === "number"
    )
  )
}

async function verifyPublicCandidate(version: string) {
  const downloadOrigin = new URL(required("FORGE_DESKTOP_DOWNLOAD_ORIGIN"))
  if (
    downloadOrigin.protocol !== "https:" ||
    downloadOrigin.username ||
    downloadOrigin.password
  ) {
    throw new Error(
      "FORGE_DESKTOP_DOWNLOAD_ORIGIN must be a public HTTPS origin."
    )
  }

  const manifestResponse = await fetch(
    new URL(`/desktop/v${version}/manifest.json`, downloadOrigin),
    { cache: "no-store" }
  )
  if (!manifestResponse.ok) {
    throw new Error(
      `The public desktop manifest is unavailable (${manifestResponse.status}).`
    )
  }
  const value: unknown = await manifestResponse.json()
  if (!isManifest(value) || value.version !== version) {
    throw new Error("The public desktop manifest is invalid.")
  }

  const identities = new Set(
    value.artifacts.map(({ architecture, kind }) => `${architecture}:${kind}`)
  )
  if (value.artifacts.length !== 4 || identities.size !== 4) {
    throw new Error(
      "The public desktop manifest must contain exactly four artifacts."
    )
  }
  for (const requiredIdentity of [
    "arm64:dmg",
    "arm64:zip",
    "x64:dmg",
    "x64:zip",
  ]) {
    if (!identities.has(requiredIdentity)) {
      throw new Error(
        `The public desktop manifest is missing ${requiredIdentity}.`
      )
    }
  }

  for (const artifact of value.artifacts) {
    const expectedPrefix = `desktop/v${version}/darwin/${artifact.architecture}/`
    if (
      !artifact.objectKey.startsWith(expectedPrefix) ||
      !/^[0-9a-f]{64}$/.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.sizeBytes) ||
      artifact.sizeBytes <= 0
    ) {
      throw new Error("The public desktop manifest contains unsafe metadata.")
    }

    const response = await fetch(
      new URL(`/${artifact.objectKey}`, downloadOrigin),
      {
        cache: "no-store",
      }
    )
    if (!response.ok) {
      throw new Error(
        `The public ${artifact.architecture} ${artifact.kind} is unavailable (${response.status}).`
      )
    }
    if (Number(response.headers.get("content-length")) !== artifact.sizeBytes) {
      throw new Error(
        `The public ${artifact.architecture} ${artifact.kind} size does not match its manifest.`
      )
    }
    const metadataChecksum = response.headers.get("x-amz-meta-sha256")
    if (
      metadataChecksum &&
      metadataChecksum.toLowerCase() !== artifact.sha256
    ) {
      throw new Error(
        `The public ${artifact.architecture} ${artifact.kind} checksum metadata does not match its manifest.`
      )
    }
    if (!response.body) {
      throw new Error(
        `The public ${artifact.architecture} ${artifact.kind} has no response body.`
      )
    }
    const hash = createHash("sha256")
    const reader = response.body.getReader()
    while (true) {
      const { done, value: chunk } = await reader.read()
      if (done) break
      hash.update(chunk)
    }
    if (hash.digest("hex") !== artifact.sha256) {
      throw new Error(
        `The public ${artifact.architecture} ${artifact.kind} checksum does not match its manifest.`
      )
    }
  }

  for (const architecture of ["arm64", "x64"] as const) {
    const checksumsResponse = await fetch(
      new URL(
        `/desktop/v${version}/darwin/${architecture}/SHA256SUMS`,
        downloadOrigin
      ),
      { cache: "no-store" }
    )
    if (!checksumsResponse.ok) {
      throw new Error(
        `The public ${architecture} checksums are unavailable (${checksumsResponse.status}).`
      )
    }
    const expectedChecksums = value.artifacts
      .filter((artifact) => artifact.architecture === architecture)
      .map(
        (artifact) =>
          `${artifact.sha256}  ${artifact.objectKey.split("/").at(-1)}`
      )
      .sort()
    const actualChecksums = (await checksumsResponse.text())
      .trim()
      .split("\n")
      .sort()
    if (
      actualChecksums.length !== expectedChecksums.length ||
      actualChecksums.some(
        (checksum, index) => checksum !== expectedChecksums[index]
      )
    ) {
      throw new Error(
        `The public ${architecture} checksums do not match the manifest.`
      )
    }
  }

  return value
}

async function verifySquirrelMetadata(
  version: string,
  manifest: ReleaseManifest
) {
  for (const architecture of ["arm64", "x64"] as const) {
    const response = await fetch(
      new URL(
        `/api/desktop/updates/darwin/${architecture}`,
        required("FORGE_RELEASE_API_ORIGIN")
      ),
      { cache: "no-store" }
    )
    if (!response.ok) {
      throw new Error(
        `The ${architecture} Squirrel endpoint failed (${response.status}).`
      )
    }
    const update = (await response.json()) as {
      name?: unknown
      url?: unknown
    }
    const zip = manifest.artifacts.find(
      (artifact) =>
        artifact.architecture === architecture && artifact.kind === "zip"
    )
    const expectedUrl = new URL(
      `/${zip?.objectKey ?? ""}`,
      required("FORGE_DESKTOP_DOWNLOAD_ORIGIN")
    ).toString()
    if (update.name !== version || update.url !== expectedUrl) {
      throw new Error(
        `The ${architecture} Squirrel endpoint does not match Forge v${version}.`
      )
    }
  }
}

const action = process.argv[2]
if (action !== "promote" && action !== "pause") {
  throw new Error("The release action must be promote or pause.")
}
validateReleaseEnvironment(action)
const version = semanticVersion(required("CI_COMMIT_TAG"), "CI_COMMIT_TAG")

if (action === "promote") {
  const manifest = await verifyPublicCandidate(version)
  await changeReleaseState(version, "promote")
  await verifySquirrelMetadata(version, manifest)
  console.log(`Promoted and verified Forge v${version}.`)
} else {
  await changeReleaseState(version, "pause")
  const fallbackValue = process.env.FORGE_DESKTOP_FALLBACK_VERSION?.trim()
  if (fallbackValue) {
    const fallbackVersion = semanticVersion(
      fallbackValue,
      "FORGE_DESKTOP_FALLBACK_VERSION"
    )
    await changeReleaseState(fallbackVersion, "promote")
    console.log(
      `Paused Forge v${version} and restored Forge v${fallbackVersion}.`
    )
  } else {
    console.log(`Paused Forge v${version}; no fallback release was selected.`)
  }
}
