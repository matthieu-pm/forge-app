// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SharedSlaSettings } from "./shared-sla-settings"
import type { SlaPolicySnapshot } from "@/lib/shared-sla-contract"

const api = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  reconcile: vi.fn(),
}))
vi.mock("./account-preference-provider", () => ({
  useProtectedIdentity: () => ({
    userId: "admin",
    workspaceId: "workspace",
    sessionId: "session",
  }),
}))
vi.mock("@/lib/shared-sla-api", () => ({
  loadSharedSlaPolicy: api.load,
  persistSharedSlaPolicy: api.save,
  reconcileSharedSlaGate: api.reconcile,
}))
afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})
const initial: SlaPolicySnapshot = {
  revision: 1,
  values: { enabled: false, workWeek: "mon-fri", rules: [] },
  canManage: true,
  teams: [],
  statuses: [],
  reconciliation: [],
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
describe("shared SLA editor refresh fencing", () => {
  it("does not let a focus refresh started during save replace the committed policy", async () => {
    const saving = deferred<{
      status: "saved"
      replayed: boolean
      snapshot: SlaPolicySnapshot
    }>()
    api.load.mockResolvedValue(initial)
    api.save.mockReturnValue(saving.promise)
    render(<SharedSlaSettings />)
    const week = await screen.findByRole("combobox", { name: "Work week" })
    fireEvent.change(week, { target: { value: "sun-thu" } })
    fireEvent.click(screen.getByRole("button", { name: "Save SLA policy" }))
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1))
    fireEvent(window, new Event("focus"))
    expect(api.load).toHaveBeenCalledTimes(1)
    await act(async () =>
      saving.resolve({
        status: "saved",
        replayed: false,
        snapshot: {
          ...initial,
          revision: 2,
          values: { ...initial.values, workWeek: "sun-thu" },
        },
      })
    )
    expect(screen.getByRole("status").textContent).toBe("SLA policy saved.")
    expect((week as HTMLSelectElement).value).toBe("sun-thu")
  })
  it("discards a refresh already in flight when the save begins", async () => {
    const stale = deferred<SlaPolicySnapshot>()
    api.load.mockResolvedValueOnce(initial).mockReturnValueOnce(stale.promise)
    api.save.mockResolvedValue({
      status: "saved",
      replayed: false,
      snapshot: {
        ...initial,
        revision: 2,
        values: { ...initial.values, workWeek: "sun-thu" },
      },
    })
    render(<SharedSlaSettings />)
    const week = await screen.findByRole("combobox", { name: "Work week" })
    fireEvent(window, new Event("focus"))
    await waitFor(() => expect(api.load).toHaveBeenCalledTimes(2))
    fireEvent.change(week, { target: { value: "sun-thu" } })
    fireEvent.click(screen.getByRole("button", { name: "Save SLA policy" }))
    await screen.findByText("SLA policy saved.")
    await act(async () => stale.resolve(initial))
    expect((week as HTMLSelectElement).value).toBe("sun-thu")
  })
})
