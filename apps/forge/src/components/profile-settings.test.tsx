import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ProfileSettings } from "./profile-settings"
import type { ProfileSnapshot } from "@/lib/profile-contract"

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  loadProfile: vi.fn(),
  saveProfile: vi.fn(),
  refetch: vi.fn(),
}))
vi.mock("@/lib/auth-client", () => ({ authClient: mocks }))
vi.mock("@/lib/profile-api", () => mocks)
vi.mock("@/components/chatgpt-sign-in", () => ({ ChatGPTSignIn: () => null }))
vi.mock("@/components/avatar-picker", () => ({ AvatarPicker: () => null }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
const profile: ProfileSnapshot = {
  userId: "alice",
  revision: "2026-11-03T00:00:00.000Z",
  name: "Alice Owner",
  title: "Engineer",
  username: null,
  image: null,
}
const session = (id = "alice") => ({
  data: {
    user: { id, name: id, email: `${id}@example.test` },
    session: { id: `${id}-session`, activeOrganizationId: "workspace" },
  },
  refetch: mocks.refetch,
})
describe("ProfileSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useSession.mockReturnValue(session())
    mocks.loadProfile.mockResolvedValue({ status: "ready", snapshot: profile })
    mocks.saveProfile.mockResolvedValue({
      status: "saved",
      snapshot: { ...profile, title: "Product engineer" },
    })
  })
  afterEach(cleanup)
  async function edit() {
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Title").disabled).toBe(
        false
      )
    )
    fireEvent.change(screen.getByLabelText<HTMLInputElement>("Title"), {
      target: { value: "Product engineer" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }))
  }
  it("loads canonical values and sends only changed fields with session/version preconditions", async () => {
    render(<ProfileSettings />)
    await edit()
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledTimes(1))
    expect(mocks.saveProfile.mock.calls[0][0].data).toMatchObject({
      sessionId: "alice-session",
      expectedWorkspaceId: "workspace",
      expectedRevision: profile.revision,
      patch: { title: "Product engineer" },
    })
    await waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1))
  })
  it("keeps the draft on conflict and requires an explicit discard before using the latest version", async () => {
    mocks.saveProfile.mockResolvedValue({
      status: "conflict",
      snapshot: { ...profile, title: "Changed elsewhere" },
    })
    render(<ProfileSettings />)
    await edit()
    const discard = await screen.findByRole("button", {
      name: "Discard draft and load latest profile",
    })
    expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe(
      "Product engineer"
    )
    expect(screen.getByLabelText<HTMLInputElement>("Title").disabled).toBe(true)
    fireEvent.click(discard)
    expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe(
      "Changed elsewhere"
    )
  })
  it("retries a failed save with the identical durable command identity and input", async () => {
    mocks.saveProfile.mockRejectedValueOnce(new Error("offline"))
    render(<ProfileSettings />)
    await edit()
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry profile update" })
    )
    await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledTimes(2))
    expect(mocks.saveProfile.mock.calls[0][0]).toEqual(
      mocks.saveProfile.mock.calls[1][0]
    )
  })
  it("discards the old account draft and ignores its late save after switching accounts", async () => {
    let resolve!: (value: unknown) => void
    mocks.saveProfile.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        })
    )
    const view = render(<ProfileSettings />)
    await edit()
    mocks.useSession.mockReturnValue(session("bob"))
    mocks.loadProfile.mockResolvedValue({
      status: "ready",
      snapshot: { ...profile, userId: "bob", name: "Bob", title: "Bob title" },
    })
    view.rerender(<ProfileSettings />)
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe(
        "Bob title"
      )
    )
    resolve({
      status: "saved",
      snapshot: { ...profile, title: "Alice result" },
    })
    await waitFor(() =>
      expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe(
        "Bob title"
      )
    )
    expect(mocks.refetch).not.toHaveBeenCalled()
  })
  it("keeps every profile editing control unavailable when gated off", async () => {
    mocks.loadProfile.mockResolvedValue({ status: "disabled" })
    render(<ProfileSettings />)
    await screen.findByText("Profile editing is unavailable.")
    for (const field of ["Full name", "Title", "Username"])
      expect(screen.getByLabelText<HTMLInputElement>(field).disabled).toBe(true)
    expect(mocks.saveProfile).not.toHaveBeenCalled()
  })
})
