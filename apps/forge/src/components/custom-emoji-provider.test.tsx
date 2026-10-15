import { act, cleanup, render, screen } from "@testing-library/react"
import { useEffect, useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  WorkspaceEmojiProvider,
  useCustomEmojis,
} from "./custom-emoji-provider"
import type { CustomEmoji } from "@/lib/custom-emoji-contract"

const mocks = vi.hoisted(() => ({
  matches: [] as Array<{ context: unknown }>,
  activeOrganizationId: "workspace-1" as string | null,
  list: vi.fn(),
  mounts: vi.fn(),
  unmounts: vi.fn(),
}))
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ matches: mocks.matches }),
}))
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({
      data: { session: { activeOrganizationId: mocks.activeOrganizationId } },
    }),
  },
}))
vi.mock("@/lib/custom-emoji-state", () => ({
  listCustomEmojis: mocks.list,
  uploadCustomEmoji: vi.fn(),
  removeCustomEmoji: vi.fn(),
}))

function Shell() {
  const [expanded, setExpanded] = useState(false)
  const { emojis } = useCustomEmojis()
  useEffect(() => {
    mocks.mounts()
    return () => {
      mocks.unmounts()
    }
  }, [])
  return (
    <>
      <button onClick={() => setExpanded(!expanded)}>
        {expanded ? "Teams expanded" : "Teams collapsed"}
      </button>
      <span>{emojis.map((emoji) => emoji.name).join(",") || "No emojis"}</span>
    </>
  )
}
function app() {
  return (
    <WorkspaceEmojiProvider>
      <Shell />
    </WorkspaceEmojiProvider>
  )
}
function workspace(id: string | null) {
  mocks.matches = [
    { context: { authState: { workspace: id ? { id } : null } } },
  ]
  mocks.activeOrganizationId = id
}
const emoji = { id: "emoji-1", name: "workspace-one" } as CustomEmoji

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  workspace("workspace-1")
  mocks.list.mockResolvedValue([emoji])
})

describe("workspace emoji scope and persistent app shell", () => {
  it("keeps the shell and its state mounted across main and team route contexts", async () => {
    const view = render(app())
    await screen.findByText("workspace-one")
    act(() => screen.getByRole("button").click())
    const sidebarButton = screen.getByRole("button")

    // Team access uses loader data, without the main route auth context.
    mocks.matches = [{ context: {} }]
    view.rerender(app())
    expect(screen.getByRole("button")).toBe(sidebarButton)
    expect(sidebarButton.textContent).toBe("Teams expanded")
    expect(screen.getByText("workspace-one")).toBeTruthy()

    workspace("workspace-1")
    view.rerender(app())
    expect(screen.getByRole("button")).toBe(sidebarButton)
    expect(mocks.mounts).toHaveBeenCalledTimes(1)
    expect(mocks.unmounts).not.toHaveBeenCalled()
    expect(mocks.list).toHaveBeenCalledTimes(1)
  })

  it("clears old workspace emojis without remounting the shell on workspace switch", async () => {
    const view = render(app())
    await screen.findByText("workspace-one")
    const sidebarButton = screen.getByRole("button")
    let resolveNew!: (emojis: Array<CustomEmoji>) => void
    const pendingNew = new Promise<Array<CustomEmoji>>((resolve) => {
      resolveNew = resolve
    })
    mocks.list.mockReturnValueOnce(pendingNew)
    workspace("workspace-2")
    view.rerender(app())
    expect(screen.getByRole("button")).toBe(sidebarButton)
    expect(screen.queryByText("workspace-one")).toBeNull()
    await act(async () => {
      resolveNew([{ ...emoji, name: "workspace-two" }])
      await pendingNew
    })
    await screen.findByText("workspace-two")
    expect(mocks.mounts).toHaveBeenCalledTimes(1)
  })

  it("ignores an old workspace response after access is cleared", async () => {
    let resolveOld!: (emojis: Array<CustomEmoji>) => void
    const pendingOld = new Promise<Array<CustomEmoji>>((resolve) => {
      resolveOld = resolve
    })
    mocks.list.mockReturnValueOnce(pendingOld)
    const view = render(app())
    const sidebarButton = screen.getByRole("button")
    workspace(null)
    view.rerender(app())
    await act(async () => {
      resolveOld([emoji])
      await pendingOld
    })
    expect(screen.queryByText("workspace-one")).toBeNull()
    expect(screen.getByRole("button")).toBe(sidebarButton)
    expect(mocks.list).toHaveBeenCalledTimes(1)
  })
})
