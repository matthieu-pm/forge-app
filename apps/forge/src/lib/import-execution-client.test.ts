import { afterEach, describe, expect, it, vi } from "vitest"
import {
  migrateServerSources,
  resumeLegacyImport,
} from "./import-execution-client"
import {
  bindLegacyImportFile,
  executeLegacyImport,
  loadLegacyImport,
  pauseLegacyImport,
  prepareLegacyImport,
} from "./import-execution-state"
import { uploadFileDirect } from "./files/direct-upload-client"
import type { ImportSnapshot } from "./import-execution-contract"

let epoch = 0
vi.mock("./canonical-issue-cache", () => ({
  canonicalIssueEpoch: () => epoch,
  canonicalIssueState: () => ({
    workspaceId: "workspace",
    sessionId: "session",
  }),
}))
vi.mock("./issue-file-client", () => ({
  issueUploadContext: () => ({ assertCurrent: () => {} }),
}))
vi.mock("./import-execution-state", () => ({
  prepareLegacyImport: vi.fn(),
  pauseLegacyImport: vi.fn(),
  executeLegacyImport: vi.fn(),
  loadLegacyImport: vi.fn(),
  bindLegacyImportFile: vi.fn(),
}))
vi.mock("./files/direct-upload-client", () => ({ uploadFileDirect: vi.fn() }))
const manifest = (state: "pending" | "saved" = "pending"): ImportSnapshot => ({
  version: 1,
  policyVersion: 1,
  id: crypto.randomUUID(),
  fingerprint: "a".repeat(64),
  workspaceId: "workspace",
  actorId: "alice",
  revision: 0,
  createdAt: new Date().toISOString(),
  sources: [],
  exclusions: [],
  entries: [
    {
      id: "entry",
      sourceKey: "source",
      path: "issues/0",
      kind: "issue",
      teamId: crypto.randomUUID(),
      legacyId: "legacy",
      fingerprint: "a".repeat(64),
      title: "Source",
      files: [],
      state,
    },
  ],
})
afterEach(() => {
  epoch = 0
  vi.resetAllMocks()
})
describe("FOR-56 import driver", () => {
  it("resumes the same server checkpoint after an interrupted batch response", async () => {
    const first = manifest(),
      saved = {
        ...first,
        revision: 1,
        entries: first.entries.map((e) => ({ ...e, state: "saved" as const })),
      }
    vi.mocked(executeLegacyImport)
      .mockRejectedValueOnce(new Error("Lost response"))
      .mockResolvedValueOnce(JSON.stringify(saved))
    vi.mocked(loadLegacyImport).mockResolvedValue(JSON.stringify(first))
    await expect(resumeLegacyImport(first)).rejects.toThrow("Lost response")
    await resumeLegacyImport(first)
    expect(
      vi.mocked(executeLegacyImport).mock.calls.map(([input]) => input.data)
    ).toEqual([
      {
        workspaceId: "workspace",
        sessionId: "session",
        id: first.id,
        revision: 0,
      },
      {
        workspaceId: "workspace",
        sessionId: "session",
        id: first.id,
        revision: 0,
      },
    ])
  })
  it("does not continue preparation after an account switch", async () => {
    vi.mocked(prepareLegacyImport).mockImplementation(async () => {
      epoch++
      return JSON.stringify(manifest())
    })
    expect(await migrateServerSources()).toEqual([])
    expect(executeLegacyImport).not.toHaveBeenCalled()
  })
  it("retains one upload identity when binding loses its response", async () => {
    const m = manifest("saved"),
      id = crypto.randomUUID()
    m.entries[0].canonicalId = crypto.randomUUID()
    m.entries[0].files = [
      {
        name: "hello.txt",
        contentType: "text/plain",
        data: "data:text/plain;base64,aGVsbG8=",
        sizeBytes: 5,
        checksum: "a".repeat(64),
      },
    ]
    vi.mocked(uploadFileDirect).mockResolvedValue({ id } as Awaited<
      ReturnType<typeof uploadFileDirect>
    >)
    vi.mocked(loadLegacyImport).mockResolvedValue(JSON.stringify(m))
    vi.mocked(bindLegacyImportFile)
      .mockRejectedValueOnce(new Error("Lost binding response"))
      .mockResolvedValueOnce(
        JSON.stringify({
          ...m,
          revision: 1,
          entries: m.entries.map((e) => ({
            ...e,
            files: e.files.map((f) => ({ ...f, fileId: id })),
          })),
        })
      )
    await expect(resumeLegacyImport(m)).rejects.toThrow("Lost binding response")
    await resumeLegacyImport(m)
    const keys = vi
      .mocked(uploadFileDirect)
      .mock.calls.map((call) => call[3]?.commandKey)
    expect(keys[0]).toBeTruthy()
    expect(keys[1]).toBe(keys[0])
    expect(bindLegacyImportFile).toHaveBeenCalledTimes(2)
  })
  it("pauses automatic retries durably after an interrupted drive", async () => {
    const m = manifest()
    vi.mocked(prepareLegacyImport).mockResolvedValue(JSON.stringify(m))
    vi.mocked(loadLegacyImport).mockRejectedValue(
      new Error("Transport unavailable")
    )
    vi.mocked(pauseLegacyImport).mockResolvedValue(
      JSON.stringify({ ...m, automaticPaused: true })
    )
    await expect(migrateServerSources()).rejects.toThrow(
      "Transport unavailable"
    )
    expect(pauseLegacyImport).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace",
        sessionId: "session",
        id: m.id,
        revision: 0,
      },
    })
    vi.mocked(prepareLegacyImport).mockResolvedValue(
      JSON.stringify({ ...m, automaticPaused: true, pendingCount: 1 })
    )
    expect((await migrateServerSources())[0]).toContain("paused")
    expect(loadLegacyImport).toHaveBeenCalledTimes(1)
  })
})
