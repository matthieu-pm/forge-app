import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useSharedDocuments } from "./shared-document-client"
import { loadSharedDocuments, persistSharedDocument } from "./document-state"
import type { DocumentSource } from "./document-contract"

const identity = vi.hoisted(() => ({
  current: {
    workspaceId: "workspace",
    userId: "alice",
    sessionId: "session-a",
  },
  epoch: 0,
}))
vi.mock("./document-state", () => ({
  loadSharedDocuments: vi.fn(),
  persistSharedDocument: vi.fn(),
}))
vi.mock("./product-storage", () => ({
  productStorageIdentity: () => identity.current,
}))
vi.mock("./protected-session", () => ({
  protectedSessionEpoch: () => identity.epoch,
}))
vi.mock("./preference-session-events", () => ({
  onPreferenceSessionInvalidated: () => () => {},
}))
const source: DocumentSource = {
  kind: "team",
  id: "12345678-1234-4234-8234-123456789abc",
}
beforeEach(() => {
  localStorage.clear()
  identity.current = {
    workspaceId: "workspace",
    userId: "alice",
    sessionId: "session-a",
  }
  identity.epoch = 0
  vi.mocked(loadSharedDocuments).mockReset().mockResolvedValue("[]")
  vi.mocked(persistSharedDocument)
    .mockReset()
    .mockImplementation(async ({ data }) =>
      JSON.stringify({ status: "saved", id: data.command.id, revision: 1 })
    )
})
afterEach(cleanup)
async function client(target: DocumentSource = source) {
  const hook = renderHook(() => useSharedDocuments(target))
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  return hook
}
it("reuses the immutable creation identity/input after lost response and remount", async () => {
  vi.mocked(persistSharedDocument).mockRejectedValueOnce(
    new Error("Commit response lost")
  )
  const first = await client()
  await act(async () => {
    await expect(first.result.current.create()).rejects.toThrow(
      "Commit response lost"
    )
  })
  const submitted = structuredClone(
    vi.mocked(persistSharedDocument).mock.calls[0][0].data
  )
  expect(localStorage.length).toBe(1)
  first.unmount()
  const recovered = await client()
  let id = ""
  await act(async () => {
    id = await recovered.result.current.create()
  })
  expect(id).toBe(submitted.command.id)
  expect(vi.mocked(persistSharedDocument).mock.calls[1][0].data).toEqual(
    submitted
  )
  expect(localStorage.length).toBe(0)
  await act(async () => {
    await recovered.result.current.create()
  })
  const fresh = vi.mocked(persistSharedDocument).mock.calls[2][0].data
  expect(fresh.commandKey).not.toBe(submitted.commandKey)
  expect(fresh.command.id).not.toBe(submitted.command.id)
})
it("refuses changed creation input without retiring or replacing an uncertain command", async () => {
  vi.mocked(persistSharedDocument).mockRejectedValueOnce(new Error("Offline"))
  const hook = await client()
  await act(async () => {
    await expect(
      hook.result.current.create("section-original")
    ).rejects.toThrow("Offline")
  })
  const original = localStorage.getItem(localStorage.key(0)!)
  await act(async () => {
    await expect(hook.result.current.create("section-other")).rejects.toThrow(
      "original section"
    )
  })
  expect(persistSharedDocument).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem(localStorage.key(0)!)).toBe(original)
  await act(async () => {
    await hook.result.current.create("section-original")
  })
  expect(vi.mocked(persistSharedDocument).mock.calls[1][0].data).toEqual(
    vi.mocked(persistSharedDocument).mock.calls[0][0].data
  )
})
it("never replays another actor's pending creation after workspace/user transition", async () => {
  vi.mocked(persistSharedDocument).mockRejectedValueOnce(new Error("Offline"))
  const alice = await client()
  await act(async () => {
    await expect(alice.result.current.create()).rejects.toThrow("Offline")
  })
  const originalKey = localStorage.key(0)!,
    originalRaw = localStorage.getItem(originalKey)
  const aliceCommand = vi.mocked(persistSharedDocument).mock.calls[0][0].data
    .commandKey
  alice.unmount()
  identity.current = {
    workspaceId: "other-workspace",
    userId: "bob",
    sessionId: "session-b",
  }
  identity.epoch++
  vi.mocked(loadSharedDocuments).mockRejectedValue(new Error("Access denied"))
  vi.mocked(persistSharedDocument).mockRejectedValue(new Error("Access denied"))
  const bob = await client()
  expect(bob.result.current.documents).toEqual([])
  expect(bob.result.current.error).toBe("Access denied")
  await act(async () => {
    await expect(bob.result.current.create()).rejects.toThrow("Access denied")
  })
  const bobCommand = vi.mocked(persistSharedDocument).mock.calls[1][0].data
  expect(bobCommand.commandKey).not.toBe(aliceCommand)
  expect(bobCommand.workspaceId).toBe("other-workspace")
  expect(localStorage.getItem(originalKey)).toBe(originalRaw)
})
it("preserves a corrupt recovery record and never sends its injected operation", async () => {
  vi.mocked(persistSharedDocument).mockRejectedValueOnce(new Error("Offline"))
  const first = await client()
  await act(async () => {
    await expect(first.result.current.create()).rejects.toThrow()
  })
  first.unmount()
  const key = localStorage.key(0)!,
    record = JSON.parse(localStorage.getItem(key)!)
  record.command = {
    action: "delete",
    id: record.command.id,
    expectedRevision: 1,
  }
  const corrupt = JSON.stringify(record)
  localStorage.setItem(key, corrupt)
  const recovered = await client()
  await act(async () => {
    await expect(recovered.result.current.create()).rejects.toThrow()
  })
  expect(persistSharedDocument).toHaveBeenCalledTimes(1)
  expect(localStorage.getItem(key)).toBe(corrupt)
})
it("does not start a remote creation when its retry identity cannot be journaled", async () => {
  const hook = await client()
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("Storage full")
  })
  await act(async () => {
    await expect(hook.result.current.create()).rejects.toThrow("Storage full")
  })
  expect(persistSharedDocument).not.toHaveBeenCalled()
})

it("retains the old actor's creation journal if the session changes during confirmation refresh", async () => {
  const hook = await client()
  const refreshes: Array<(value: string) => void> = []
  vi.mocked(loadSharedDocuments).mockImplementation(
    () =>
      new Promise((resolve) => {
        refreshes.push(resolve)
      })
  )
  let creation!: Promise<string>
  act(() => {
    creation = hook.result.current.create()
  })
  await waitFor(() => expect(refreshes).toHaveLength(2))
  const originalKey = localStorage.key(0)!,
    original = localStorage.getItem(originalKey)
  identity.current = {
    workspaceId: "other-workspace",
    userId: "bob",
    sessionId: "session-b",
  }
  identity.epoch++
  await act(async () => {
    for (const resolve of refreshes) resolve("[]")
    await expect(creation).rejects.toThrow("active session changed")
  })
  expect(localStorage.getItem(originalKey)).toBe(original)
})
