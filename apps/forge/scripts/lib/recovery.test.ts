// @vitest-environment node
/* eslint-disable @typescript-eslint/require-await -- Promise-shaped test doubles intentionally resolve without real I/O. */
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { STAGING } from "../../../../packages/environment/staging-environment"
import {
  decryptEntry,
  digest,
  encryptEntry,
  openManifest,
  recoveryKey,
  sealManifest,
} from "./recovery-archive"
import {
  assertRecoveryWindow,
  assessRecoveryTimings,
  signJournal,
  verifyJournal,
} from "./recovery-contract"
import { canonicalBoolean, connectionEnvironment } from "./recovery-database"
import {
  generateRecoveryIdentity,
  unwrapRecoveryKey,
  wrapRecoveryKey,
} from "./recovery-key-custody"
import { replayDeletionJournal } from "./recovery"
import type { RecoveryManifest } from "./recovery-contract"

vi.mock("@tanstack/react-start/server-only", () => ({}))
const directories: Array<string> = []
const temporary = async () => {
  const path = await mkdtemp(join(tmpdir(), "forge-recovery-unit-"))
  directories.push(path)
  return path
}
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true })
})
const source = {
  ...STAGING.database,
  database: "forge_recovery_source",
  storeId: STAGING.blobStoreId,
}
const manifest = () =>
  ({
    version: 1,
    id: randomUUID(),
    sourceRevision: "a".repeat(40),
    capturedAt: "2026-10-30T10:00:00.000Z",
    completedAt: "2026-10-30T10:01:00.000Z",
    expiresAt: "2026-12-04T10:00:00.000Z",
    source,
    tables: [],
    schemaSha256: "a".repeat(64),
    database: { entry: "database", sha256: "a".repeat(64), size: 1 },
    credentialKey: {
      entry: "credential-key",
      sha256: "a".repeat(64),
      size: 44,
    },
    files: [],
    credentialCounts: { model: 1, meeting: 1 },
  }) as RecoveryManifest
describe("FOR-38 encrypted backup entries", () => {
  it("streams a binary entry and authenticates exact bytes", async () => {
    const dir = await temporary(),
      key = randomBytes(32),
      bytes = Buffer.concat([Buffer.from("secret\u0000"), randomBytes(200000)])
    const entry = await encryptEntry(
      dir,
      "database",
      [bytes.subarray(0, 500), bytes.subarray(500)],
      key
    )
    expect(entry).toEqual({
      entry: "database",
      sha256: digest(bytes),
      size: bytes.length,
    })
    expect(
      (await readFile(join(dir, "database.aes"))).includes(
        Buffer.from("secret")
      )
    ).toBe(false)
    await decryptEntry(dir, entry, join(dir, "out"), key)
    expect(await readFile(join(dir, "out"))).toEqual(bytes)
    await expect(encryptEntry(dir, "database", [bytes], key)).rejects.toThrow()
  })
  it.each([
    "wrong-key",
    "corrupt-tag",
    "corrupt-body",
    "wrong-checksum",
    "wrong-size",
    "missing",
  ])("fails closed on %s", async (fault) => {
    const dir = await temporary(),
      key = randomBytes(32),
      entry = await encryptEntry(
        dir,
        "database",
        [Buffer.from("test bytes")],
        key
      )
    const path = join(dir, "database.aes")
    if (fault === "corrupt-tag" || fault === "corrupt-body") {
      const bytes = await readFile(path)
      bytes[fault === "corrupt-tag" ? bytes.length - 1 : 13] ^= 1
      await writeFile(path, bytes)
    }
    if (fault === "missing") await rm(path)
    await expect(
      decryptEntry(
        dir,
        {
          ...entry,
          ...(fault === "wrong-checksum" ? { sha256: "0".repeat(64) } : {}),
          ...(fault === "wrong-size" ? { size: 999 } : {}),
        },
        join(dir, "out"),
        fault === "wrong-key" ? randomBytes(32) : key
      )
    ).rejects.toThrow()
    await expect(readFile(join(dir, "out"))).rejects.toThrow()
  })
  it("seals manifest identities and binds encrypted entries to their names", async () => {
    const dir = await temporary(),
      temp = await temporary(),
      key = randomBytes(32),
      value = manifest()
    await sealManifest(dir, value, key)
    expect(await openManifest(dir, temp, key)).toEqual(value)
    await expect(
      encryptEntry(dir, "../escape", [Buffer.from("bad")], key)
    ).rejects.toThrow()
    await expect(
      encryptEntry(dir, "/absolute", [Buffer.from("bad")], key)
    ).rejects.toThrow()
  })
  it("capture requires only a public key; a different private key cannot recover", async () => {
    const dir = await temporary(),
      other = await temporary()
    await generateRecoveryIdentity(
      join(dir, "private.pem"),
      join(dir, "public.pem")
    )
    const key = await wrapRecoveryKey(dir, join(dir, "public.pem"))
    expect(await unwrapRecoveryKey(dir, join(dir, "private.pem"))).toEqual(key)
    await generateRecoveryIdentity(
      join(other, "private.pem"),
      join(other, "public.pem")
    )
    await expect(
      unwrapRecoveryKey(dir, join(other, "private.pem"))
    ).rejects.toThrow("MISSING_OR_WRONG")
  })
  it("rejects missing or malformed symmetric keys", () => {
    expect(recoveryKey(randomBytes(32).toString("base64"))).toHaveLength(32)
    for (const value of [
      "",
      "a",
      randomBytes(31).toString("base64"),
      "!".repeat(44),
    ])
      expect(() => recoveryKey(value)).toThrow()
  })
})
describe("FOR-38 journal and timing gates", () => {
  it("does not widen a captured role when an older event was published late", async () => {
    const eventId = randomUUID()
    let role = "member"
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("to_regclass('public.recovery_events')"))
          return { rows: [{ table: "recovery_events" }] }
        if (sql.includes("to_regclass('public.recovery_journal_state')"))
          return { rows: [{ table: null }] }
        if (sql.startsWith("SELECT id FROM public.recovery_events"))
          return { rows: [{ id: eventId }] }
        if (sql.startsWith("SELECT a.attname"))
          return { rows: [{ attname: "id" }] }
        if (sql.startsWith('UPDATE public."member"')) role = "owner"
        return { rows: [] }
      }),
    }
    const journal = signJournal(
      {
        version: 1,
        source,
        from: "2026-10-30T10:00:00.000Z",
        through: "2026-10-30T10:05:00.000Z",
        entries: [
          {
            sequence: 1,
            at: "2026-10-30T10:05:00.000Z",
            change: {
              id: eventId,
              sequence: 1,
              at: "2026-10-30T09:59:00.000Z",
              table: "member",
              key: { id: "membership" },
              action: "patch",
              patch: { role: "owner" },
              storageReference: null,
            },
          },
        ],
      },
      randomBytes(32)
    )
    await replayDeletionJournal(client, journal)
    expect(role).toBe("member")
  })
  it("accepts equivalent Postgres CHECK grouping while preserving AND/OR precedence and quoted content", () => {
    expect(canonicalBoolean("((a > 0 AND b > 0) AND c > 0)")).toBe(
      canonicalBoolean("(a > 0 AND b > 0 AND c > 0)")
    )
    expect(canonicalBoolean("(a > 0 AND (b > 0 OR c > 0))")).not.toBe(
      canonicalBoolean("((a > 0 AND b > 0) OR c > 0)")
    )
    expect(canonicalBoolean("(name = 'a AND b' AND enabled)")).not.toBe(
      canonicalBoolean("(name = 'a' AND b AND enabled)")
    )
  })
  const key = randomBytes(32)
  const journal = () =>
    signJournal(
      {
        version: 1,
        source,
        from: "2026-10-30T09:00:00.000Z",
        through: "2026-10-30T10:05:00.000Z",
        entries: [
          {
            sequence: 1,
            at: "2026-10-30T10:02:00.000Z",
            table: "issues",
            id: randomUUID(),
          },
        ],
      },
      key
    )
  it("accepts current independently authenticated deletion coverage", () =>
    expect(
      verifyJournal(journal(), key, manifest(), "2026-10-30T10:04:00.000Z")
        .entries
    ).toHaveLength(1))
  it("refuses tampered deletion entries", () => {
    const j = journal()
    j.entries = []
    expect(() =>
      verifyJournal(j, key, manifest(), "2026-10-30T10:04:00.000Z")
    ).toThrow("SIGNATURE")
  })
  it.each([
    "stale",
    "late-start",
    "gap",
    "foreign-source",
    "future-entry",
    "reverse",
  ])("rejects %s journal", (fault) => {
    const { signature: _, ...j } = journal()
    if (fault === "stale") j.through = "2026-10-30T10:03:00.000Z"
    if (fault === "late-start") j.from = "2026-10-30T10:01:00.000Z"
    if (fault === "gap") j.entries[0].sequence = 2
    if (fault === "foreign-source")
      j.source = { ...source, database: "foreign" }
    if (fault === "future-entry") j.entries[0].at = "2026-10-30T10:06:00.000Z"
    if (fault === "reverse")
      j.entries.push({
        ...j.entries[0],
        sequence: 2,
        at: "2026-10-30T10:01:00.000Z",
      })
    expect(() =>
      verifyJournal(
        signJournal(j, key),
        key,
        manifest(),
        "2026-10-30T10:04:00.000Z"
      )
    ).toThrow()
  })
  it("never resets the 35-day capture clock", () => {
    const m = manifest()
    expect(() =>
      assertRecoveryWindow(m, new Date(m.expiresAt), "2026-10-30T10:04:00.000Z")
    ).toThrow()
    m.expiresAt = "2026-12-05T10:00:00.000Z"
    expect(() =>
      assertRecoveryWindow(
        m,
        new Date("2026-10-30T10:05:00.000Z"),
        "2026-10-30T10:04:00.000Z"
      )
    ).toThrow()
  })
  it.each([
    [3600, 14400, true],
    [3601, 14400, false],
    [3600, 14401, false],
    [-1, 1, false],
    [1, -1, false],
  ])("measures RPO=%s/RTO=%s", (rpo, rto, passed) => {
    const capture = Date.parse("2026-10-30T10:00:00Z"),
      incident = capture + Number(rpo) * 1000
    expect(
      assessRecoveryTimings(
        new Date(capture).toISOString(),
        new Date(incident).toISOString(),
        new Date(incident + Number(rto) * 1000).toISOString()
      ).passed
    ).toBe(passed)
  })
  it("excludes production, pooled and forged targets before connections", () => {
    const target = { ...source, database: "forge_recovery_target" },
      url = `postgresql://test:secret@${source.host}/forge_recovery_target?sslmode=require`
    expect(connectionEnvironment(url, target, "target").PGDATABASE).toBe(
      target.database
    )
    for (const identity of [
      { ...target, branchId: "br-production" },
      { ...target, database: "forge_staging" },
      { ...target, storeId: "store_production" },
    ])
      expect(() => connectionEnvironment(url, identity, "target")).toThrow()
    expect(() =>
      connectionEnvironment(
        url.replace(source.host, source.host.replace(".", "-pooler.")),
        target,
        "target"
      )
    ).toThrow()
    expect(() =>
      connectionEnvironment(url + "&options=malicious", target, "target")
    ).toThrow()
  })
})
