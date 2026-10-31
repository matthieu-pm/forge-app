import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { refreshCanonicalIssues } from "./canonical-issue-client"
import {
  canonicalIssueState,
  replaceCanonicalIssues,
} from "./canonical-issue-cache"
import { loadCanonicalIssues } from "./canonical-issue-state"
import { persistProductState } from "./product-state-server"
import {
  flushProductStorage,
  initializeProductStorage,
  productStorage,
  resetProductStorage,
  storageStatus,
} from "./product-storage"
import { retireProtectedSession } from "./protected-session"
import { projectCommandPrefix } from "./shared-project-key"
import type { CanonicalSnapshot } from "./canonical-issue-cache"

vi.mock("./canonical-issue-state", () => ({
  loadCanonicalIssues: vi.fn(),
  loadIssueDetail: vi.fn(),
  persistCanonicalIssue: vi.fn(),
}))
vi.mock("./product-state-server", () => ({
  persistProductState: vi.fn(),
  loadProductState: vi.fn(),
}))
vi.mock("./issue-file-client", () => ({ finishCreatedIssueFiles: vi.fn() }))

const identity = {
  workspaceId: "workspace",
  sessionId: "session",
  userId: "user",
}
const project = {
  id: "00000000-0000-4000-8000-000000000001",
  revision: 2,
  name: "Private project",
  legacyId: null,
  properties: {},
}
const snapshot = (
  projects: CanonicalSnapshot["projects"] = [project]
): CanonicalSnapshot => ({ ...identity, records: [], cycles: [], projects })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.mocked(loadCanonicalIssues).mockReset()
  vi.mocked(persistProductState).mockReset()
  window.localStorage.clear()
  initializeProductStorage({ ...identity, entries: [] }, false)
  replaceCanonicalIssues(snapshot())
})
afterEach(() => {
  resetProductStorage()
  replaceCanonicalIssues(null, false)
  vi.restoreAllMocks()
})

it("does not restore a revoked project from an older overlapping metadata response", async () => {
  const old = deferred<string>(),
    latest = deferred<string>()
  vi.mocked(loadCanonicalIssues)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(latest.promise)
  const oldRead = refreshCanonicalIssues(identity)
  const rejected = expect(oldRead).rejects.toThrow("workspace refreshed")
  const latestRead = refreshCanonicalIssues(identity)
  latest.resolve(JSON.stringify(snapshot([])))
  await latestRead
  expect(canonicalIssueState()?.projects).toEqual([])
  old.resolve(JSON.stringify(snapshot()))
  await rejected
  expect(canonicalIssueState()?.projects).toEqual([])
})

it("rejects a metadata response after protected-session retirement before canonical identity reset", async () => {
  const response = deferred<string>()
  vi.mocked(loadCanonicalIssues).mockReturnValueOnce(response.promise)
  const read = refreshCanonicalIssues(identity)
  const rejected = expect(read).rejects.toThrow("active session changed")
  retireProtectedSession()
  response.resolve(
    JSON.stringify(snapshot([{ ...project, name: "Late metadata" }]))
  )
  await rejected
  expect(canonicalIssueState()?.projects).toEqual([project])
})

it("keeps a superseded project save refresh retryable with its exact immutable command", async () => {
  const old = deferred<string>(),
    latest = deferred<string>()
  vi.mocked(loadCanonicalIssues)
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(latest.promise)
  vi.mocked(persistProductState).mockResolvedValue({
    replayed: false,
    value: { revision: 1 },
  })
  productStorage.setItem(
    `${projectCommandPrefix}${crypto.randomUUID()}`,
    JSON.stringify([
      {
        id: project.id,
        expectedRevision: project.revision,
        changes: { name: "Saved" },
      },
    ])
  )
  await vi.waitFor(() => expect(loadCanonicalIssues).toHaveBeenCalledTimes(1))
  const original = vi.mocked(persistProductState).mock.calls[0][0]
  const latestRead = refreshCanonicalIssues(identity)
  latest.resolve(JSON.stringify(snapshot([])))
  await latestRead
  old.resolve(JSON.stringify(snapshot()))
  await vi.waitFor(() =>
    expect(storageStatus().error).toContain("workspace refreshed")
  )
  expect(storageStatus().pending).toBe(1)
  expect(canonicalIssueState()?.projects).toEqual([])
  vi.mocked(loadCanonicalIssues).mockResolvedValue(
    JSON.stringify(snapshot([{ ...project, revision: 3, name: "Saved" }]))
  )
  await flushProductStorage()
  expect(vi.mocked(persistProductState).mock.calls[1][0]).toEqual(original)
  expect(storageStatus().pending).toBe(0)
  expect(canonicalIssueState()?.projects[0].name).toBe("Saved")
})
