import { z } from "zod"
import { describeLegacyKey, inspectLegacySource } from "./legacy-import-sources"
import {
  LEGACY_IMPORT_POLICY_VERSION,
  evaluateLegacyImportReview,
} from "./legacy-import-policy"
import type {
  SourceDescriptor,
  SourceInspection,
} from "./legacy-import-sources"
import type { DefinitionSnapshot } from "./issue-definition-contract"

export type PreviewContext = {
  actorId: string
  accountLabel?: string
  sessionId: string
  workspace: { id: string; name: string }
  teams: Array<{
    id: string
    name: string
    visibility: "workspace" | "private"
  }>
  definitions: Array<DefinitionSnapshot>
}
export type LegacySource = SourceDescriptor &
  SourceInspection & { key: string; raw: string; checksum: string }
export type LegacySnapshot = {
  actorId: string
  sources: Array<LegacySource>
  excludedAccounts: number
  excludedUnknown: number
  excludedDevice: number
  fingerprint: string
}
export type StorageReader = Pick<Storage, "length" | "key" | "getItem">

/** Hash serialized strings: JSON escapes lone surrogates, preserving UTF-16 exactly. */
export async function legacyChecksum(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(hash), (v) =>
    v.toString(16).padStart(2, "0")
  ).join("")
}

export async function discoverLegacySources(
  storage: StorageReader,
  actorId: string
): Promise<LegacySnapshot> {
  if (!actorId.trim()) throw new Error("Sign in before reviewing browser data.")
  const keys = Array.from({ length: storage.length }, (_, index) =>
    storage.key(index)
  )
    .filter((key): key is string => key !== null)
    .sort()
  const sources: Array<LegacySource> = []
  let excludedAccounts = 0,
    excludedUnknown = 0,
    excludedDevice = 0
  for (const key of keys) {
    const descriptor = describeLegacyKey(key)
    if (!descriptor) {
      excludedUnknown++
      continue
    }
    // Never read another account's personal payload, even if it is malformed.
    if (descriptor.accountHint && descriptor.accountHint !== actorId) {
      excludedAccounts++
      continue
    }
    if (descriptor.kind === "device") {
      excludedDevice++
      continue
    }
    const raw = storage.getItem(key)
    if (raw === null) throw new Error("Browser data changed. Preview again.")
    sources.push({
      ...descriptor,
      ...inspectLegacySource(descriptor, raw),
      key,
      raw,
      checksum: await legacyChecksum(raw),
    })
  }
  // Only eligible source changes invalidate this scan. Other accounts and device
  // state may change concurrently without becoming part of the reviewed snapshot.
  const currentKeys = Array.from({ length: storage.length }, (_, index) =>
    storage.key(index)
  )
    .filter((key): key is string => {
      if (key === null) return false
      const source = describeLegacyKey(key)
      return Boolean(
        source &&
        source.kind !== "device" &&
        (!source.accountHint || source.accountHint === actorId)
      )
    })
    .sort()
  if (
    currentKeys.length !== sources.length ||
    sources.some(
      (source, index) =>
        source.key !== currentKeys[index] ||
        storage.getItem(source.key) !== source.raw
    )
  )
    throw new Error("Browser data changed. Preview again.")
  return {
    actorId,
    sources,
    excludedAccounts,
    excludedUnknown,
    excludedDevice,
    fingerprint: await legacyChecksum(
      sources.map(({ key, checksum }) => ({ key, checksum }))
    ),
  }
}

export type SourceChoice = {
  key: string
  paths: Array<string>
  /** null = workspace definitions; empty = no destination chosen. */
  teamId: string | null
  ownershipConfirmed: boolean
  conflicts: Partial<Record<string, "keep-server" | "keep-both">>
}
export type PreviewCandidate = {
  path: string
  reason: string
  definition: boolean
}

export function previewCandidates(
  source: LegacySource,
  teamId: string | null,
  context: PreviewContext,
  sources: Array<LegacySource> = [source],
  choices: Array<SourceChoice> = []
): Array<PreviewCandidate> {
  const target = context.definitions.find((d) => d.teamId === teamId)
  const selected = new Map(
    choices
      .filter((choice) => choice.teamId === teamId)
      .map((choice) => [choice.key, new Set(choice.paths)])
  )
  return source.records.flatMap((r) => {
    const definition = source.kind === "labels" || source.kind === "statuses"
    const directory =
      source.kind === "labels"
        ? r.path.startsWith("groups/")
          ? target?.value.labels.groups
          : target?.value.labels.labels
        : source.kind === "statuses"
          ? target?.value.statuses.statuses
          : []
    if (
      directory?.some(
        (d) => d.id === r.id || d.name.toLowerCase() === r.title.toLowerCase()
      )
    )
      return [
        {
          path: r.path,
          reason:
            "A destination definition has the same ID or name. Keep the server definition; explicit mapping or renaming will be required by the executor.",
          definition: true,
        },
      ]
    if (
      selected.get(source.key)?.has(r.path) &&
      sources.some(
        (otherSource) =>
          selected.has(otherSource.key) &&
          (otherSource.kind === source.kind ||
            (["issues", "triage", "cycles"].includes(otherSource.kind) &&
              ["issues", "triage", "cycles"].includes(source.kind))) &&
          otherSource.records.some(
            (other) =>
              (otherSource !== source || other.path !== r.path) &&
              selected.get(otherSource.key)?.has(other.path) &&
              (source.kind !== "labels" ||
                other.path.split("/")[0] === r.path.split("/")[0]) &&
              (other.id === r.id || other.title === r.title)
          )
      )
    )
      return [
        {
          path: r.path,
          reason:
            "Another source record has this ID or title. Matching text does not establish identity.",
          definition,
        },
      ]
    return []
  })
}

const backupEntrySchema = z
  .object({
    key: z.string(),
    raw: z.string(),
    checksum: z.string(),
    version: z.string(),
  })
  .strict()
export const legacyBackupSchema = z
  .object({
    format: z.literal("forge-legacy-backup"),
    version: z.literal(1),
    policyVersion: z.literal(1),
    id: z.string().min(1),
    actorId: z.string().min(1),
    createdAt: z.iso.datetime(),
    sourceFingerprint: z.string(),
    entries: z.array(backupEntrySchema).min(1),
    checksum: z.string(),
  })
  .strict()
export type LegacyBackup = z.infer<typeof legacyBackupSchema>
export type BackupRepository = {
  put: (backup: LegacyBackup) => Promise<void>
  get: (id: string) => Promise<unknown>
}

export async function verifyLegacyBackup(
  value: unknown
): Promise<LegacyBackup> {
  const backup = legacyBackupSchema.parse(value)
  const { checksum, ...body } = backup
  if (
    new Set(backup.entries.map((e) => e.key)).size !== backup.entries.length ||
    (await legacyChecksum(body)) !== checksum
  )
    throw new Error("The backup could not be verified.")
  for (const entry of backup.entries) {
    const descriptor = describeLegacyKey(entry.key)
    if (
      !descriptor ||
      descriptor.kind === "device" ||
      (descriptor.accountHint && descriptor.accountHint !== backup.actorId) ||
      (await legacyChecksum(entry.raw)) !== entry.checksum
    )
      throw new Error("The backup contains an invalid source.")
  }
  return backup
}

export async function preserveLegacyBackup(
  snapshot: LegacySnapshot,
  keys: Array<string>,
  repository: BackupRepository
): Promise<LegacyBackup> {
  if (!keys.length || new Set(keys).size !== keys.length)
    throw new Error("Select sources to back up.")
  const entries = [...keys].sort().map((key) => {
    const source = snapshot.sources.find((s) => s.key === key)
    if (!source) throw new Error("Preview these sources again.")
    return {
      key,
      raw: source.raw,
      checksum: source.checksum,
      version: source.version,
    }
  })
  const body = {
    format: "forge-legacy-backup" as const,
    version: 1 as const,
    policyVersion: 1 as const,
    id: crypto.randomUUID(),
    actorId: snapshot.actorId,
    createdAt: new Date().toISOString(),
    sourceFingerprint: snapshot.fingerprint,
    entries,
  }
  const backup = { ...body, checksum: await legacyChecksum(body) }
  await repository.put(backup)
  const verified = await verifyLegacyBackup(await repository.get(backup.id))
  if (verified.checksum !== backup.checksum)
    throw new Error("The saved backup did not match the preview.")
  return verified
}

/** Local review artifact only. FOR-56 must revalidate all bytes, permissions,
 * references, aliases and server conflicts; this is never an authorization token. */
export async function confirmLegacyPreview(input: {
  snapshot: LegacySnapshot
  currentSnapshot: LegacySnapshot
  context: PreviewContext
  currentContext: PreviewContext
  choices: Array<SourceChoice>
  backup: unknown
}) {
  const { snapshot, currentSnapshot, context, currentContext, choices } = input
  if (
    snapshot.actorId !== context.actorId ||
    currentSnapshot.actorId !== context.actorId ||
    snapshot.fingerprint !== currentSnapshot.fingerprint ||
    (await legacyChecksum(context)) !== (await legacyChecksum(currentContext))
  )
    throw new Error(
      "The account, destination, permissions or browser data changed. Preview again."
    )
  const backup = await verifyLegacyBackup(input.backup)
  if (
    backup.actorId !== context.actorId ||
    backup.sourceFingerprint !== snapshot.fingerprint
  )
    throw new Error("Create a backup of this preview first.")
  if (
    !choices.length ||
    new Set(choices.map((c) => c.key)).size !== choices.length
  )
    throw new Error("Select records to review.")
  const exclusions = {
    sources: snapshot.sources.map((source) => ({
      key: source.key,
      version: source.version,
      status: source.status,
      reasons: source.exclusions,
      unselectedPaths: source.records
        .filter(
          (record) =>
            !choices
              .find((choice) => choice.key === source.key)
              ?.paths.includes(record.path)
        )
        .map((record) => record.path),
    })),
    otherAccountSources: snapshot.excludedAccounts,
    deviceSources: snapshot.excludedDevice,
    unknownKeys: snapshot.excludedUnknown,
  }
  const selectionFingerprint = await legacyChecksum({
    exclusions,
    policyVersion: LEGACY_IMPORT_POLICY_VERSION,
    context,
    choices,
  })
  for (const choice of choices) {
    const source = snapshot.sources.find((s) => s.key === choice.key)
    if (
      !source ||
      !choice.paths.length ||
      new Set(choice.paths).size !== choice.paths.length ||
      choice.paths.some((path) => !source.records.some((r) => r.path === path))
    )
      throw new Error("Select valid records from the preview.")
    const team = currentContext.teams.find((t) => t.id === choice.teamId)
    const definition = source.kind === "labels" || source.kind === "statuses"
    if (
      choice.teamId === "" ||
      (!team &&
        !(
          choice.teamId === null &&
          source.kind === "labels" &&
          !source.teamHint
        ))
    )
      throw new Error("Choose a destination for every selected source.")
    if (
      definition &&
      !currentContext.definitions.find((d) => d.teamId === choice.teamId)
        ?.canManage
    )
      throw new Error("You do not have permission to import definitions here.")
    const entry = backup.entries.find((e) => e.key === source.key)
    const destination = {
      kind: "workspace" as const,
      workspaceId: context.workspace.id,
      ...(team ? { teamId: team.id } : {}),
    }
    const reviewed = {
      policyVersion: LEGACY_IMPORT_POLICY_VERSION,
      actorId: context.actorId,
      destination,
      sourceFingerprint: source.checksum,
      selectionFingerprint,
    }
    const decision = evaluateLegacyImportReview({
      ...reviewed,
      sourceStatus:
        source.status === "backup-only" ? "unsupported" : source.status,
      sourceAccountHint: source.accountHint,
      canWriteDestination: Boolean(team) || choice.teamId === null,
      backupVerified: entry?.checksum === source.checksum,
      confirmation: {
        ...reviewed,
        ownershipConfirmed: choice.ownershipConfirmed,
      },
    })
    if (decision !== "ready")
      throw new Error(
        "Confirm ownership and preserve a verified backup for every selected source."
      )
    for (const candidate of previewCandidates(
      source,
      choice.teamId,
      context,
      snapshot.sources,
      choices
    )) {
      if (
        choice.paths.includes(candidate.path) &&
        (!choice.conflicts[candidate.path] ||
          (candidate.definition &&
            choice.conflicts[candidate.path] !== "keep-server"))
      )
        throw new Error("Review every selected conflict before confirming.")
    }
  }
  return {
    format: "forge-legacy-review" as const,
    version: 1,
    policyVersion: LEGACY_IMPORT_POLICY_VERSION,
    actorId: context.actorId,
    workspaceId: context.workspace.id,
    sourceFingerprint: snapshot.fingerprint,
    selectionFingerprint,
    backupId: backup.id,
    backupChecksum: backup.checksum,
    choices: structuredClone(choices),
    exclusions,
    destinations: choices.map((choice) => ({
      key: choice.key,
      workspaceId: context.workspace.id,
      teamId: choice.teamId,
      visibility:
        context.teams.find((team) => team.id === choice.teamId)?.visibility ??
        "workspace",
      expectedDefinitionRevision:
        context.definitions.find(
          (definition) => definition.teamId === choice.teamId
        )?.revision ?? null,
    })),
    confirmedAt: new Date().toISOString(),
    execution: "unavailable" as const,
  }
}
