import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  PersonNameProvider,
  usePersonName,
  usePersonNamesEnabled,
} from "./person-name-provider"

const state = vi.hoisted(() => ({
  identity: {
    userId: "viewer",
    workspaceId: "workspace-a",
    sessionId: "session-a",
  },
  load: vi.fn(),
}))
vi.mock("./account-preference-provider", () => ({
  useProtectedIdentity: () => state.identity,
  usePreferenceGroup: () => ({ preferences: { displayNames: "username" } }),
}))
vi.mock("@/lib/person-directory-state", () => ({
  loadPersonDirectory: state.load,
}))
function Consumer() {
  const personName = usePersonName()
  const enabled = usePersonNamesEnabled()
  return (
    <output>
      {enabled ? personName({ id: "member", name: "Snapshot" }) : "Unavailable"}
    </output>
  )
}
function deferred() {
  let resolve!: (value: {
    enabled: boolean
    people: Array<{ id: string; name: string; username: string }>
  }) => void
  const promise = new Promise<Parameters<typeof resolve>[0]>((done) => {
    resolve = done
  })
  return { resolve, promise }
}
const directory = (username: string) => ({
  enabled: true,
  people: [{ id: "member", name: "Current full name", username }],
})
beforeEach(() => {
  state.load.mockReset()
  state.identity = {
    userId: "viewer",
    workspaceId: "workspace-a",
    sessionId: "session-a",
  }
})
afterEach(cleanup)

it("clears names synchronously on workspace changes and discards late responses from the previous scope", async () => {
  const first = deferred(),
    second = deferred()
  state.load
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
  const view = render(
    <PersonNameProvider>
      <Consumer />
    </PersonNameProvider>
  )
  expect(screen.getByText("Unavailable")).toBeTruthy()
  state.identity = { ...state.identity, workspaceId: "workspace-b" }
  view.rerender(
    <PersonNameProvider>
      <Consumer />
    </PersonNameProvider>
  )
  await act(async () => {
    second.resolve(directory("second-workspace"))
    await second.promise
  })
  expect(screen.getByText("second-workspace")).toBeTruthy()
  await act(async () => {
    first.resolve(directory("private-old-workspace"))
    await first.promise
  })
  expect(screen.queryByText("private-old-workspace")).toBeNull()
  expect(state.load).toHaveBeenLastCalledWith({
    data: { workspaceId: "workspace-b", sessionId: "session-a" },
  })
})

it("refreshes changed profiles and prevents an older same-scope response from overwriting the latest directory", async () => {
  const older = deferred(),
    newer = deferred()
  state.load
    .mockResolvedValueOnce(directory("original"))
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(newer.promise)
  render(
    <PersonNameProvider>
      <Consumer />
    </PersonNameProvider>
  )
  await screen.findByText("original")
  act(() => {
    window.dispatchEvent(new Event("focus"))
    window.dispatchEvent(new Event("forge:person-profile-changed"))
  })
  await act(async () => {
    newer.resolve(directory("updated"))
    await newer.promise
  })
  await act(async () => {
    older.resolve(directory("stale"))
    await older.promise
  })
  expect(screen.getByText("updated")).toBeTruthy()
})

it("fails closed for disabled and failed directory reads", async () => {
  state.load
    .mockResolvedValueOnce({ enabled: false, people: [] })
    .mockRejectedValueOnce(new Error("offline"))
  render(
    <PersonNameProvider>
      <Consumer />
    </PersonNameProvider>
  )
  await waitFor(() => expect(state.load).toHaveBeenCalledTimes(1))
  expect(screen.getByText("Unavailable")).toBeTruthy()
  act(() => window.dispatchEvent(new Event("focus")))
  await waitFor(() => expect(state.load).toHaveBeenCalledTimes(2))
  expect(screen.getByText("Unavailable")).toBeTruthy()
})
