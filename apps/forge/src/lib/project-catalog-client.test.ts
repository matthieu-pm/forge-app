import { afterEach, expect, it, vi } from "vitest"
import { persistProductState } from "./product-state-server"
import {
  flushProductStorage,
  initializeProductStorage,
  productStorage,
  resetProductStorage,
} from "./product-storage"

vi.mock("./product-state-server", () => ({
  persistProductState: vi.fn(),
  loadProductState: vi.fn(),
}))
afterEach(() => {
  resetProductStorage()
  vi.clearAllMocks()
})
it("advances acknowledged label catalog versions so consecutive saves use the confirmed version", async () => {
  const key = "forge:workspace-project-labels:v1"
  initializeProductStorage({
    workspaceId: "workspace",
    userId: "alice",
    sessionId: "session",
    entries: [
      {
        key,
        revision: 0,
        value: JSON.stringify({
          version: 1,
          catalogRevision: 0,
          labels: [],
          groups: [],
          inheritedCount: 0,
        }),
      },
    ],
  })
  vi.mocked(persistProductState)
    .mockResolvedValueOnce({ value: { revision: 1 }, replayed: false })
    .mockResolvedValueOnce({ value: { revision: 2 }, replayed: false })
  productStorage.setItem(
    key,
    JSON.stringify({
      ...JSON.parse(productStorage.getItem(key)!),
      labels: [{ id: "first" }],
    })
  )
  await flushProductStorage()
  expect(JSON.parse(productStorage.getItem(key)!).catalogRevision).toBe(1)
  productStorage.setItem(
    key,
    JSON.stringify({
      ...JSON.parse(productStorage.getItem(key)!),
      labels: [{ id: "second" }],
    })
  )
  await flushProductStorage()
  const sent = vi.mocked(persistProductState).mock.calls[1][0].data
  expect(sent.expectedRevision).toBe(1)
  expect(JSON.parse(sent.value!).catalogRevision).toBe(1)
  expect(JSON.parse(productStorage.getItem(key)!).catalogRevision).toBe(2)
})
