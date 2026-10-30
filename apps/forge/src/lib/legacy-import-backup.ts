import { describeLegacyKey } from "./legacy-import-sources"
import { legacyChecksum, verifyLegacyBackup } from "./legacy-import-preview"
import { loadProductState, persistProductState } from "./product-state-server"
import { productStorageIdentity } from "./product-storage"
import type { BackupRepository, LegacyBackup } from "./legacy-import-preview"

const keyFor = (id: string) => `forge:legacy-backup:v1:${id}`
// Compatibility export: backups now persist in authenticated server storage.
export const browserBackupRepository: BackupRepository = {
  async put(backup: LegacyBackup) {
    const before = productStorageIdentity()
    if (!before || before.userId !== backup.actorId)
      throw new Error("Sign in to the account that owns this backup.")
    const verified = await verifyLegacyBackup(backup),
      current = productStorageIdentity()
    if (
      current?.sessionId !== before.sessionId ||
      current.workspaceId !== before.workspaceId
    )
      throw new Error("The active account changed.")
    await persistProductState({
      data: {
        workspaceId: before.workspaceId,
        sessionId: before.sessionId,
        commandKey: /^[0-9a-f-]{36}$/i.test(verified.id)
          ? verified.id
          : crypto.randomUUID(),
        key: keyFor(verified.id),
        value: JSON.stringify(verified),
        expectedRevision: 0,
      },
    })
  },
  async get(id: string) {
    const snapshot = await loadProductState(),
      value = snapshot.entries.find((e) => e.key === keyFor(id))?.value
    if (!value) {
      const recovered = snapshot.entries.find((entry) => entry.key === id)
      return recovered?.value
        ? recoveredBackup(recovered, snapshot.userId)
        : undefined
    }
    const backup = await verifyLegacyBackup(JSON.parse(value))
    return backup.actorId === snapshot.userId ? backup : undefined
  },
}
export async function listBrowserBackups(
  actorId: string
): Promise<Array<LegacyBackup>> {
  const snapshot = await loadProductState()
  if (snapshot.userId !== actorId) return []
  const backups: Array<LegacyBackup> = []
  for (const entry of snapshot.entries)
    if (entry.key.startsWith("forge:legacy-backup:v1:") && entry.value) {
      const backup = await verifyLegacyBackup(JSON.parse(entry.value))
      if (backup.actorId === actorId) backups.push(backup)
    }
  for (const entry of snapshot.entries)
    if (
      entry.value &&
      /^forge:(?:pending-recovery|legacy-conflict):v1:/.test(entry.key)
    ) {
      const backup = await recoveredBackup(entry, actorId)
      if (backup) backups.push(backup)
    }
  return [
    ...new Map(backups.map((backup) => [backup.id, backup])).values(),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
async function recoveredBackup(
  entry: { key: string; value: string | null },
  actorId: string
): Promise<LegacyBackup | undefined> {
  try {
    const source = JSON.parse(entry.value!),
      descriptor = describeLegacyKey(source.key)
    if (
      typeof source.value !== "string" ||
      !descriptor ||
      descriptor.kind === "device" ||
      (descriptor.accountHint && descriptor.accountHint !== actorId)
    )
      return undefined
    const createdAt = source.createdAt ?? source.importedAt
    if (typeof createdAt !== "string") return undefined
    const body = {
      format: "forge-legacy-backup" as const,
      version: 1 as const,
      policyVersion: 1 as const,
      id: entry.key,
      actorId,
      createdAt,
      sourceFingerprint: await legacyChecksum([source.key, source.value]),
      entries: [
        {
          key: source.key,
          raw: source.value,
          version: descriptor.version,
          checksum: await legacyChecksum(source.value),
        },
      ],
    }
    return verifyLegacyBackup({ ...body, checksum: await legacyChecksum(body) })
  } catch {
    return undefined
  }
}
export function downloadLegacyFile(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })
  )
  try {
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = name
    anchor.click()
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
