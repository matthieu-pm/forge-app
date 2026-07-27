import "@tanstack/react-start/server-only"

import { and, asc, desc, eq } from "drizzle-orm"

import type { RegisterDesktopReleaseInput } from "@/application/desktop-releases/desktop-release-contract"
import { db, desktopReleaseArtifacts, desktopReleases } from "@/db"

function publicArtifactUrl(objectKey: string) {
  const configured = process.env.FORGE_DESKTOP_DOWNLOAD_ORIGIN?.trim()
  if (!configured) {
    throw new Error("FORGE_DESKTOP_DOWNLOAD_ORIGIN is not configured.")
  }

  const origin = new URL(configured)
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("FORGE_DESKTOP_DOWNLOAD_ORIGIN must be a safe HTTPS URL.")
  }

  return new URL(`/${objectKey}`, origin).toString()
}

export async function registerDesktopRelease(
  input: RegisterDesktopReleaseInput
) {
  const expectedPrefix = `desktop/v${input.version}/darwin/`
  if (
    input.artifacts.some(
      ({ objectKey }) => !objectKey.startsWith(expectedPrefix)
    )
  ) {
    throw new Error("Every artifact key must match the registered version.")
  }

  await db
    .insert(desktopReleases)
    .values({
      version: input.version,
      state: "draft",
      releaseNotes: input.releaseNotes,
    })
    .onConflictDoNothing({ target: desktopReleases.version })

  const [release] = await db
    .select()
    .from(desktopReleases)
    .where(eq(desktopReleases.version, input.version))
    .limit(1)

  if (!release) {
    throw new Error("The desktop release could not be registered.")
  }
  if (release.state !== "draft") {
    throw new Error("Only draft releases accept artifact registration.")
  }

  for (const artifact of input.artifacts) {
    const [existing] = await db
      .select()
      .from(desktopReleaseArtifacts)
      .where(
        and(
          eq(desktopReleaseArtifacts.releaseId, release.id),
          eq(desktopReleaseArtifacts.platform, artifact.platform),
          eq(desktopReleaseArtifacts.architecture, artifact.architecture),
          eq(desktopReleaseArtifacts.kind, artifact.kind)
        )
      )
      .limit(1)

    if (existing) {
      if (
        existing.objectKey !== artifact.objectKey ||
        existing.sha256 !== artifact.sha256 ||
        existing.sizeBytes !== artifact.sizeBytes
      ) {
        throw new Error(
          "An immutable desktop artifact was registered with different metadata."
        )
      }
      continue
    }

    await db.insert(desktopReleaseArtifacts).values({
      releaseId: release.id,
      platform: artifact.platform,
      architecture: artifact.architecture,
      kind: artifact.kind,
      objectKey: artifact.objectKey,
      publicUrl: publicArtifactUrl(artifact.objectKey),
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
      notarizationRef: artifact.notarizationRef,
    })
  }

  return { id: release.id, version: release.version, state: release.state }
}

async function requireCompleteRelease(version: string) {
  const [release] = await db
    .select()
    .from(desktopReleases)
    .where(eq(desktopReleases.version, version))
    .limit(1)

  if (!release) throw new Error("Desktop release not found.")
  if (
    release.state !== "draft" &&
    release.state !== "paused" &&
    release.state !== "superseded"
  ) {
    throw new Error(
      "Only a draft, paused, or superseded release can be promoted."
    )
  }

  const artifacts = await db
    .select({
      architecture: desktopReleaseArtifacts.architecture,
      kind: desktopReleaseArtifacts.kind,
    })
    .from(desktopReleaseArtifacts)
    .where(eq(desktopReleaseArtifacts.releaseId, release.id))

  const identities = new Set(
    artifacts.map((artifact) => `${artifact.architecture}:${artifact.kind}`)
  )
  for (const required of ["arm64:dmg", "arm64:zip", "x64:dmg", "x64:zip"]) {
    if (!identities.has(required)) {
      throw new Error(`Desktop release is missing ${required}.`)
    }
  }

  return release
}

export async function promoteDesktopRelease(version: string) {
  const release = await requireCompleteRelease(version)
  const now = new Date()

  await db.transaction(async (transaction) => {
    await transaction
      .update(desktopReleases)
      .set({ state: "superseded" })
      .where(eq(desktopReleases.state, "promoted"))
    await transaction
      .update(desktopReleases)
      .set({ state: "promoted", promotedAt: now })
      .where(eq(desktopReleases.id, release.id))
  })

  return {
    id: release.id,
    version: release.version,
    state: "promoted" as const,
  }
}

export async function pauseDesktopRelease(version: string) {
  const [release] = await db
    .update(desktopReleases)
    .set({ state: "paused" })
    .where(
      and(
        eq(desktopReleases.version, version),
        eq(desktopReleases.state, "promoted")
      )
    )
    .returning({ id: desktopReleases.id, version: desktopReleases.version })

  if (!release) throw new Error("The promoted desktop release was not found.")
  return { ...release, state: "paused" as const }
}

export async function getPromotedDesktopRelease() {
  const [release] = await db
    .select()
    .from(desktopReleases)
    .where(eq(desktopReleases.state, "promoted"))
    .orderBy(desc(desktopReleases.promotedAt))
    .limit(1)

  if (!release) return null

  const artifacts = await db
    .select()
    .from(desktopReleaseArtifacts)
    .where(eq(desktopReleaseArtifacts.releaseId, release.id))
    .orderBy(
      asc(desktopReleaseArtifacts.architecture),
      asc(desktopReleaseArtifacts.kind)
    )

  return {
    id: release.id,
    version: release.version,
    releaseNotes: release.releaseNotes,
    promotedAt:
      release.promotedAt?.toISOString() ?? release.createdAt.toISOString(),
    artifacts: artifacts.map((artifact) => ({
      architecture: artifact.architecture as "arm64" | "x64",
      kind: artifact.kind as "dmg" | "zip",
      url: artifact.publicUrl,
      sha256: artifact.sha256,
      sizeBytes: artifact.sizeBytes,
    })),
  }
}

export async function getDesktopUpdate(architecture: "arm64" | "x64") {
  const release = await getPromotedDesktopRelease()
  if (!release) return null

  const artifact = release.artifacts.find(
    (candidate) =>
      candidate.architecture === architecture && candidate.kind === "zip"
  )
  if (!artifact) return null

  return {
    url: artifact.url,
    name: release.version,
    notes: release.releaseNotes,
    pub_date: release.promotedAt,
  }
}
