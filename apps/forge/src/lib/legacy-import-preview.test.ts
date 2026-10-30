import { webcrypto } from "node:crypto"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  confirmLegacyPreview,
  discoverLegacySources,
  legacyChecksum,
  preserveLegacyBackup,
  previewCandidates,
  verifyLegacyBackup,
} from "./legacy-import-preview"
import { describeLegacyKey, inspectLegacySource } from "./legacy-import-sources"
import { blankIssueDraft, initialIssueStore } from "./team-issues"
import { defaultDefinitionValue } from "./issue-definition-contract"
import { initialTeamLabels } from "./team-labels"
import type {
  BackupRepository,
  LegacyBackup,
  PreviewContext,
  SourceChoice,
} from "./legacy-import-preview"

beforeAll(() => vi.stubGlobal("crypto", webcrypto))
afterAll(() => vi.unstubAllGlobals())
beforeEach(() => localStorage.clear())
const issueKey = "forge:team-issues:v1:legacy-team"
const labelKey = "forge:team-issue-labels:legacy-team:v1"
const documentKey = 'forge:signal-documents:v1:["old-workspace","alice"]'

function seed() {
  localStorage.setItem(
    issueKey,
    JSON.stringify({
      ...initialIssueStore(),
      issues: [
        {
          ...blankIssueDraft(),
          id: "legacy-issue",
          number: 6,
          title: "Keep my work",
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:00:00Z",
          statusChangedAt: "2026-10-01T00:00:00Z",
          creator: "Unverified author",
          suggestedLabel: "",
          completedAt: null,
          assignee: "old-user",
          parentId: "old-parent",
        },
      ],
    })
  )
  localStorage.setItem(labelKey, JSON.stringify(initialTeamLabels("forge")))
  localStorage.setItem(documentKey, "{damaged document\u0000\ud800")
}
function context(): PreviewContext {
  return {
    actorId: "alice",
    sessionId: "session-alice",
    workspace: { id: "workspace", name: "Destination" },
    teams: [{ id: "team", name: "Team", visibility: "private" }],
    definitions: [
      {
        workspaceId: "workspace",
        teamId: "team",
        revision: 4,
        canManage: true,
        value: defaultDefinitionValue(),
      },
      {
        workspaceId: "workspace",
        teamId: null,
        revision: 0,
        canManage: true,
        value: defaultDefinitionValue(),
      },
    ],
  }
}
function repository(): BackupRepository {
  const stored = new Map<string, unknown>()
  return {
    put: (backup) => {
      stored.set(backup.id, JSON.parse(JSON.stringify(backup)))
      return Promise.resolve()
    },
    get: (id) => Promise.resolve(stored.get(id)),
  }
}
function choices(): Array<SourceChoice> {
  return [
    {
      key: issueKey,
      paths: ["issues/0"],
      teamId: "team",
      ownershipConfirmed: true,
      conflicts: {},
    },
  ]
}
async function fixture() {
  seed()
  const snapshot = await discoverLegacySources(localStorage, "alice")
  const backup = await preserveLegacyBackup(
    snapshot,
    snapshot.sources.map((s) => s.key),
    repository()
  )
  const ctx = context()
  return {
    snapshot,
    currentSnapshot: snapshot,
    context: ctx,
    currentContext: ctx,
    choices: choices(),
    backup,
  }
}

describe("FOR-53 source inventory and read-only preview (AC-01 / AT-01)", () => {
  it("counts real issues and labels, reports malformed documents, references and mixed-store exclusions without writing", async () => {
    seed()
    const before = { ...localStorage }
    const snapshot = await discoverLegacySources(localStorage, "alice")
    expect(snapshot.sources.find((s) => s.key === issueKey)).toMatchObject({
      status: "supported",
      counts: { issues: 1 },
      records: [
        {
          id: "legacy-issue",
          references: expect.arrayContaining([
            "assignee: old-user",
            "parentId: old-parent",
          ]),
        },
      ],
    })
    expect(
      snapshot.sources.find((s) => s.key === labelKey)?.counts.labels
    ).toBe(2)
    expect(snapshot.sources.find((s) => s.key === documentKey)).toMatchObject({
      status: "malformed",
      counts: { invalidRecordsOrFields: 1 },
      raw: before[documentKey],
    })
    expect(
      snapshot.sources.find((s) => s.key === issueKey)?.exclusions.join(" ")
    ).toContain("Drafts")
    expect({ ...localStorage }).toEqual(before)
  })
  it("never reads or exports other-account, unknown, device, or authenticated cache payloads", async () => {
    seed()
    localStorage.setItem("forge:profile:bob", "SECRET")
    localStorage.setItem('forge:inbox:v1:["w","bob"]', "SECRET")
    localStorage.setItem("forge.agent.composer-state.v1", "SECRET")
    localStorage.setItem("unrelated-token", "SECRET")
    localStorage.setItem('["forge.preferences",1,"account","bob"]', "SECRET")
    const reader = {
      length: localStorage.length,
      key: (index: number) => localStorage.key(index),
      getItem: vi.fn((key: string) => {
        if (
          [
            "forge:profile:bob",
            'forge:inbox:v1:["w","bob"]',
            "forge.agent.composer-state.v1",
            "unrelated-token",
          ].includes(key)
        )
          throw new Error("Must not read")
        return localStorage.getItem(key)
      }),
    }
    const snapshot = await discoverLegacySources(reader, "alice")
    expect(snapshot.excludedAccounts).toBe(2)
    expect(snapshot.excludedUnknown).toBe(2)
    const backup = await preserveLegacyBackup(
      snapshot,
      snapshot.sources.map((s) => s.key),
      repository()
    )
    expect(JSON.stringify(backup)).not.toContain("SECRET")
  })
  it.each([
    ["forge:workspace:w:custom-views:v1:alice:directory", "alice", "w"],
    ["forge:workspace:w:projects-view:v1:alice:all", "alice", "w"],
    ['forge:signal-documents:v1:["w","alice"]', "alice", "w"],
    ["forge:signals:v1:alice%3Aa:w%3Aa", "alice:a", "w:a"],
    ["forge:my-issues:v1:alice", "alice", undefined],
  ])(
    "recognizes personal scopes without inferring ownership: %s",
    (key, accountHint, workspaceHint) => {
      expect(describeLegacyKey(key)).toMatchObject({
        accountHint,
        ...(workspaceHint ? { workspaceHint } : {}),
      })
    }
  )
  it("preserves unsupported future schemas and missing stores without generating fixtures", async () => {
    expect(
      (await discoverLegacySources(localStorage, "alice")).sources
    ).toEqual([])
    localStorage.setItem(
      "forge:team-issues:v8:team",
      '{"version":8,"issues":[]}'
    )
    const snapshot = await discoverLegacySources(localStorage, "alice")
    expect(snapshot.sources[0].status).toBe("unsupported")
    expect(
      (
        await preserveLegacyBackup(
          snapshot,
          [snapshot.sources[0].key],
          repository()
        )
      ).entries[0].raw
    ).toContain('"version":8')
  })
  it("reports invalid record counts and fails closed for a partially damaged source", () => {
    const raw = JSON.stringify({
      ...initialIssueStore(),
      issues: [{ id: "broken", title: 9 }],
    })
    const inspected = inspectLegacySource(describeLegacyKey(issueKey)!, raw)
    expect(inspected.status).toBe("malformed")
    expect(inspected.counts.issues).toBe(1)
    expect(inspected.counts.invalidRecordsOrFields).toBeGreaterThan(0)
    expect(inspected.records).toEqual([])
  })
  it("rejects storage failures and a snapshot that changes during discovery", async () => {
    seed()
    const reader = {
      length: localStorage.length,
      key: (i: number) => localStorage.key(i),
      getItem: () => {
        throw new Error("storage denied")
      },
    }
    await expect(discoverLegacySources(reader, "alice")).rejects.toThrow(
      "storage denied"
    )
    let reads = 0
    await expect(
      discoverLegacySources(
        {
          ...reader,
          getItem: (key) => {
            reads++
            return reads > localStorage.length
              ? "changed"
              : localStorage.getItem(key)
          },
        },
        "alice"
      )
    ).rejects.toThrow("changed")
  })
})

describe("recoverable, exact local backups", () => {
  it("round-trips exact malformed UTF-16 and embedded file strings with verified checksums", async () => {
    const input = await fixture()
    const parsed = JSON.parse(JSON.stringify(input.backup)) as LegacyBackup
    expect(await verifyLegacyBackup(parsed)).toEqual(input.backup)
    expect(parsed.entries.find((e) => e.key === documentKey)?.raw).toBe(
      localStorage.getItem(documentKey)
    )
    expect(await legacyChecksum("\ud800")).not.toBe(
      await legacyChecksum("\ufffd")
    )
    localStorage.setItem(
      "forge:triage-draft:v1:team",
      '{"attachments":[{"data":"data:text/plain;base64,SGVsbG8="}]}'
    )
    const source = await discoverLegacySources(localStorage, "alice")
    const backup = await preserveLegacyBackup(
      source,
      ["forge:triage-draft:v1:team"],
      repository()
    )
    expect(backup.entries[0].raw).toBe(
      localStorage.getItem("forge:triage-draft:v1:team")
    )
  })
  it("blocks preservation when quota is exhausted, saved data is unreadable or corrupted", async () => {
    const input = await fixture()
    await expect(
      preserveLegacyBackup(input.snapshot, [issueKey], {
        put: () => Promise.reject(new Error("QuotaExceededError")),
        get: () => Promise.resolve(null),
      })
    ).rejects.toThrow("QuotaExceededError")
    await expect(
      preserveLegacyBackup(input.snapshot, [issueKey], {
        put: () => Promise.resolve(),
        get: () => Promise.resolve({}),
      })
    ).rejects.toThrow()
    const corrupted = structuredClone(input.backup)
    corrupted.entries[0].raw += "corrupted"
    await expect(verifyLegacyBackup(corrupted)).rejects.toThrow("verified")
    expect(localStorage.getItem(documentKey)).toBe(
      input.snapshot.sources.find((s) => s.key === documentKey)?.raw
    )
  })
})

describe("specific destination and ownership confirmation (AC-02 / AT-02)", () => {
  it("confirms only the selected paths with exact source, account and destination bindings", async () => {
    const input = await fixture()
    const review = await confirmLegacyPreview(input)
    expect(review).toMatchObject({
      actorId: "alice",
      workspaceId: "workspace",
      sourceFingerprint: input.snapshot.fingerprint,
      backupId: input.backup.id,
      execution: "unavailable",
      choices: choices(),
    })
    expect(JSON.stringify(review)).not.toContain("Unverified author")
  })
  it.each([
    { paths: [] },
    { paths: ["issues/999"] },
    { teamId: "" },
    { teamId: "another-team" },
    { teamId: null },
    { ownershipConfirmed: false },
  ])("rejects missing or ambiguous choices: %j", async (patch) => {
    const input = await fixture()
    input.choices = [{ ...choices()[0], ...patch }]
    await expect(confirmLegacyPreview(input)).rejects.toThrow()
  })
  it.each([
    "actor",
    "session",
    "workspace",
    "membership",
    "permission",
    "definition",
    "visibility",
    "source",
  ])("requires fresh review when %s changes", async (kind) => {
    const input = await fixture()
    input.currentContext = structuredClone(input.context)
    if (kind === "actor") input.currentContext.actorId = "bob"
    if (kind === "session") input.currentContext.sessionId = "new-session"
    if (kind === "workspace")
      input.currentContext.workspace.id = "other-workspace"
    if (kind === "membership") input.currentContext.teams = []
    if (kind === "permission")
      input.currentContext.definitions[0].canManage = false
    if (kind === "definition") input.currentContext.definitions[0].revision++
    if (kind === "visibility")
      input.currentContext.teams[0].visibility = "workspace"
    if (kind === "source")
      input.currentSnapshot = { ...input.snapshot, fingerprint: "changed" }
    await expect(confirmLegacyPreview(input)).rejects.toThrow("changed")
  })
  it("rejects missing backups, unbacked source selection and malformed sources", async () => {
    const input = await fixture()
    await expect(
      confirmLegacyPreview({ ...input, backup: null })
    ).rejects.toThrow()
    const backup = await preserveLegacyBackup(
      input.snapshot,
      [documentKey],
      repository()
    )
    await expect(confirmLegacyPreview({ ...input, backup })).rejects.toThrow(
      "backup"
    )
    await expect(
      confirmLegacyPreview({
        ...input,
        choices: [{ ...choices()[0], key: documentKey }],
      })
    ).rejects.toThrow()
  })
  it("binds selections, exclusions and conflict decisions to a new fingerprint", async () => {
    const input = await fixture()
    const first = await confirmLegacyPreview(input)
    const second = await confirmLegacyPreview({
      ...input,
      choices: [{ ...choices()[0], conflicts: { "issues/0": "keep-both" } }],
    })
    expect(first.selectionFingerprint).not.toBe(second.selectionFingerprint)
  })
  it("shows cross-store duplicate candidates and requires an explicit keep/skip choice", async () => {
    const input = await fixture()
    localStorage.setItem(
      "forge:cycle-issues:v1:legacy-team",
      JSON.stringify([
        {
          id: "legacy-issue",
          number: 6,
          title: "Keep my work",
          cycle: "old-cycle",
          description: "",
          status: "todo",
          priority: "Low",
          createdAt: "2026-10-01T00:00:00Z",
        },
      ])
    )
    input.snapshot = await discoverLegacySources(localStorage, "alice")
    input.currentSnapshot = input.snapshot
    input.backup = await preserveLegacyBackup(
      input.snapshot,
      [issueKey],
      repository()
    )
    expect(
      previewCandidates(
        input.snapshot.sources.find((s) => s.key === issueKey)!,
        "team",
        input.context,
        input.snapshot.sources
      )
    ).toHaveLength(1)
    await expect(confirmLegacyPreview(input)).rejects.toThrow("conflict")
    input.choices[0].conflicts["issues/0"] = "keep-both"
    await expect(confirmLegacyPreview(input)).resolves.toMatchObject({
      execution: "unavailable",
    })
  })
  it("requires admin permission and a non-overwrite decision for destination definition conflicts", async () => {
    const input = await fixture()
    const source = input.snapshot.sources.find((s) => s.key === labelKey)!
    input.context.definitions[0].value.labels = initialTeamLabels("forge")
    input.choices = [
      {
        key: labelKey,
        paths: ["labels/0"],
        teamId: "team",
        ownershipConfirmed: true,
        conflicts: {},
      },
    ]
    expect(previewCandidates(source, "team", input.context)[0].definition).toBe(
      true
    )
    await expect(confirmLegacyPreview(input)).rejects.toThrow("conflict")
    input.choices[0].conflicts["labels/0"] = "keep-both"
    await expect(confirmLegacyPreview(input)).rejects.toThrow("conflict")
    input.choices[0].conflicts["labels/0"] = "keep-server"
    await expect(confirmLegacyPreview(input)).resolves.toMatchObject({
      execution: "unavailable",
    })
    input.context.definitions[0].canManage = false
    await expect(confirmLegacyPreview(input)).rejects.toThrow("permission")
  })
})
