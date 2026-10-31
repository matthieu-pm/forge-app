import { beforeEach, describe, expect, it, vi } from "vitest"
import { finishCreatedIssueFiles, sendIssueFiles } from "./issue-file-client"
import { replaceCanonicalIssues } from "./canonical-issue-cache"

const mock = vi.hoisted(() => ({
  persist: vi.fn(),
  save: vi.fn(),
  upload: vi.fn(),
  values: new Map<string, string>(),
}))
vi.mock("./issue-file-state", () => ({ persistIssueFiles: mock.persist }))
vi.mock("./files/direct-upload-client", () => ({
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
      finishCreatedIssueFiles(input.teamId, input.issueId, files, "create-key")
    ).rejects.toThrow("Response lost")
    await finishCreatedIssueFiles(
      input.teamId,
      input.issueId,
      files,
      "create-key"
    )
    await finishCreatedIssueFiles(
      input.teamId,
      input.issueId,
      files,
      "create-key"
    )
    expect(mock.upload).toHaveBeenCalledTimes(1)
    expect(mock.persist).toHaveBeenCalledTimes(2)
    expect(mock.persist.mock.calls[0][0].data.commandKey).toBe(
      mock.persist.mock.calls[1][0].data.commandKey
    )
  })
})
