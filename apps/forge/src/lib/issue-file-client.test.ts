import { beforeEach, describe, expect, it, vi } from "vitest"
import { retireProtectedSession } from "./protected-session"
import {
  discardCreationFileJob,
  finishCreatedIssueFiles,
  issueUploadContext,
  sendIssueFiles,
} from "./issue-file-client"
import { UploadClientError } from "./files/direct-upload-client"
import { replaceCanonicalIssues } from "./canonical-issue-cache"
import type * as DirectUploadModule from "./files/direct-upload-client"

const mock = vi.hoisted(() => ({
  persist: vi.fn(),
  save: vi.fn(),
  upload: vi.fn(),
  values: new Map<string, string>(),
}))
vi.mock("./issue-file-state", () => ({ persistIssueFiles: mock.persist }))
vi.mock("./files/direct-upload-client", async (original) => ({
  ...(await original<typeof DirectUploadModule>()),
  uploadFileDirect: mock.upload,
}))
vi.mock("./product-storage", () => ({
  saveProductValue: mock.save,
  productStorage: { getItem: (key: string) => mock.values.get(key) ?? null },
}))
const identity = {
  workspaceId: "workspace",
  userId: "alice",
  sessionId: "session",
  records: [],
  projects: [],
  cycles: [],
}
const input = {
  commandKey: crypto.randomUUID(),
  teamId: crypto.randomUUID(),
  issueId: crypto.randomUUID(),
  action: "attach" as const,
  fileIds: [crypto.randomUUID()],
}
beforeEach(() => {
  replaceCanonicalIssues(identity)
  mock.values.clear()
  mock.save.mockReset().mockImplementation(async (key, value) => {
    if (value === null) mock.values.delete(key)
    else mock.values.set(key, value)
  })
  mock.persist
    .mockReset()
    .mockResolvedValue(JSON.stringify({ status: "saved", records: [] }))
  mock.upload.mockReset().mockResolvedValue({ id: input.fileIds[0] })
})
describe("FOR-48 durable file retries", () => {
  it("saves an exact retry identity before publication and retains it on an uncertain response", async () => {
    mock.persist.mockRejectedValueOnce(new Error("Response lost"))
    await expect(sendIssueFiles(input)).rejects.toThrow("Response lost")
    expect(mock.save).toHaveBeenCalledTimes(1)
    expect(JSON.parse(mock.save.mock.calls[0][1])).toEqual(input)
    await sendIssueFiles(input)
    expect(mock.persist.mock.calls.map((c) => c[0].data.commandKey)).toEqual([
      input.commandKey,
      input.commandKey,
    ])
    expect(mock.save.mock.calls.at(-1)?.[1]).toBeNull()
  })
  it("does not publish after a draft persistence failure or session change", async () => {
    mock.save.mockRejectedValueOnce(new Error("Offline"))
    await expect(sendIssueFiles(input)).rejects.toThrow("Offline")
    expect(mock.persist).not.toHaveBeenCalled()
    mock.persist.mockImplementation(async () => {
      replaceCanonicalIssues({ ...identity, userId: "bob", sessionId: "other" })
      return JSON.stringify({ status: "saved", records: [] })
    })
    await expect(sendIssueFiles(input)).rejects.toThrow("session changed")
    expect(mock.save.mock.calls.at(-1)?.[1]).not.toBeNull()
  })
  it("resumes creation after a lost binding response without uploading or binding twice", async () => {
    const files = [
      { name: "evidence.txt", data: "data:text/plain;base64,ZXZpZGVuY2U=" },
    ]
    mock.persist.mockRejectedValueOnce(new Error("Response lost"))
    await expect(
      finishCreatedIssueFiles(
        input.teamId,
        input.issueId,
        files,
        "create-key",
        true
      )
    ).rejects.toThrow("Response lost")
    await finishCreatedIssueFiles(
      input.teamId,
      input.issueId,
      files,
      "create-key",
      true
    )
    await finishCreatedIssueFiles(
      input.teamId,
      input.issueId,
      files,
      "create-key",
      true
    )
    expect(mock.upload).toHaveBeenCalledTimes(1)
    expect(mock.persist).toHaveBeenCalledTimes(2)
    expect(mock.persist.mock.calls[0][0].data.commandKey).toBe(
      mock.persist.mock.calls[1][0].data.commandKey
    )
  })
})

it("does not clear a newer view's retry after an older command completes", async () => {
  const newer = { ...input, commandKey: crypto.randomUUID() }
  mock.persist.mockImplementation(async () => {
    mock.values.set(
      `forge:file-draft:v1:${input.issueId}:issue`,
      JSON.stringify(newer)
    )
    return JSON.stringify({ status: "saved", records: [] })
  })
  await sendIssueFiles(input)
  expect(
    JSON.parse(mock.values.get(`forge:file-draft:v1:${input.issueId}:issue`)!)
  ).toEqual(newer)
})
it("retains creation source before a refused upload and resumes from the issue job after reload", async () => {
  const files = [
    { name: "evidence.txt", data: "data:text/plain;base64,ZXZpZGVuY2U=" },
  ]
  mock.upload.mockRejectedValueOnce(new Error("File type refused"))
  await expect(
    finishCreatedIssueFiles(
      input.teamId,
      input.issueId,
      files,
      "create-key",
      true
    )
  ).rejects.toThrow("File type refused")
  const source = mock.values.get(
    `forge:file-draft:v1:${input.issueId}:creation`
  )!
  expect(JSON.parse(source).files).toEqual(files)
  await finishCreatedIssueFiles(input.teamId, input.issueId, [], "create-key")
  expect(mock.upload).toHaveBeenCalledTimes(2)
  expect(
    JSON.parse(
      mock.values.get(`forge:file-draft:v1:${input.issueId}:creation`)!
    )
  ).toMatchObject({ completed: true, files: [] })
})

it("shares one active creation completion across remounted views", async () => {
  const files = [
    { name: "evidence.txt", data: "data:text/plain;base64,ZXZpZGVuY2U=" },
  ]
  let resolve!: (value: { id: string }) => void
  mock.upload.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r
    })
  )
  const first = finishCreatedIssueFiles(
    input.teamId,
    input.issueId,
    files,
    "create-key",
    true
  )
  const second = finishCreatedIssueFiles(
    input.teamId,
    input.issueId,
    files,
    "create-key",
    true
  )
  expect(first).toBe(second)
  await vi.waitFor(() => expect(mock.upload).toHaveBeenCalledOnce())
  resolve({ id: input.fileIds[0] })
  await Promise.all([first, second])
  expect(mock.upload).toHaveBeenCalledOnce()
  expect(mock.persist).toHaveBeenCalledOnce()
})
it("uses a stable upload key across separate failed completion attempts", async () => {
  const files = [
    { name: "evidence.txt", data: "data:text/plain;base64,ZXZpZGVuY2U=" },
  ]
  mock.upload.mockRejectedValueOnce(new Error("Network failed"))
  await expect(
    finishCreatedIssueFiles(
      input.teamId,
      input.issueId,
      files,
      "create-key",
      true
    )
  ).rejects.toThrow("Network failed")
  await finishCreatedIssueFiles(input.teamId, input.issueId, [], "create-key")
  expect(mock.upload.mock.calls[0][3].commandKey).toBe(
    mock.upload.mock.calls[1][3].commandKey
  )
})
it("discard cancels an active job before binding and stale views cannot resurrect it", async () => {
  const files = [
    { name: "evidence.txt", data: "data:text/plain;base64,ZXZpZGVuY2U=" },
  ]
  let resolve!: (value: { id: string }) => void
  mock.upload.mockReturnValueOnce(
    new Promise((r) => {
      resolve = r
    })
  )
  const running = finishCreatedIssueFiles(
    input.teamId,
    input.issueId,
    files,
    "create-key",
    true
  )
  const stopped = expect(running).rejects.toThrow("cancelled")
  await vi.waitFor(() => expect(mock.upload).toHaveBeenCalledOnce())
  const discarded = discardCreationFileJob(input.issueId)
  expect(mock.upload.mock.calls[0][3].signal.aborted).toBe(true)
  resolve({ id: input.fileIds[0] })
  await stopped
  await discarded
  expect(mock.persist).not.toHaveBeenCalled()
  expect(mock.values.has(`forge:file-draft:v1:${input.issueId}:creation`)).toBe(
    false
  )
  await expect(
    finishCreatedIssueFiles(input.teamId, input.issueId, files, "create-key")
  ).rejects.toThrow("discarded")
})

it("rotates a definitively expired upload attempt while retaining its original source", async () => {
  const files = [
    { name: "evidence.txt", data: "data:text/plain;base64,ZXZpZGVuY2U=" },
  ]
  let terminalKey: string | undefined
  mock.upload.mockImplementation(async (_input, _fetch, _sessions, context) => {
    terminalKey ??= context.commandKey
    if (context.commandKey === terminalKey)
      throw new UploadClientError("INVALID_UPLOAD", "Intent is expired")
    return { id: input.fileIds[0] }
  })
  await expect(
    finishCreatedIssueFiles(
      input.teamId,
      input.issueId,
      files,
      "create-key",
      true
    )
  ).rejects.toThrow("expired")
  expect(
    JSON.parse(
      mock.values.get(`forge:file-draft:v1:${input.issueId}:creation`)!
    )
  ).toMatchObject({ attempts: { "0": 1 }, files })
  await finishCreatedIssueFiles(input.teamId, input.issueId, [], "create-key")
  expect(mock.upload.mock.calls[1][3].commandKey).not.toBe(terminalKey)
  expect(mock.persist).toHaveBeenCalledOnce()
})

it("stops selected bytes as soon as the protected session retires, before cache reset", () => {
  const context = issueUploadContext()
  context.assertCurrent?.()
  retireProtectedSession()
  expect(() => context.assertCurrent?.()).toThrow("session changed")
})
