import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { ProjectStatusesSettings } from "./project-statuses-settings"
import {
  projectStatusesStorageKey,
  readProjectStatuses,
  saveProjectStatus,
  writeProjectStatuses,
} from "@/lib/project-statuses"

vi.mock("@tanstack/react-router", () => ({
  useBlocker: vi.fn(),
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string
    children: React.ReactNode
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))
beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
it("creates, recolors, reorders, deletes and restores a project status", async () => {
  render(<ProjectStatusesSettings workspaceId="a" />)
  fireEvent.click(
    screen.getByRole("button", { name: "Create project status in In Progress" })
  )
  fireEvent.change(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Status name" }),
    {
      target: { value: "In Review" },
    }
  )
  fireEvent.click(screen.getByRole("button", { name: "Status color" }))
  fireEvent.click(await screen.findByRole("button", { name: "Green" }))
  fireEvent.click(screen.getByRole("button", { name: "Create" }))
  await screen.findByRole("button", { name: "Edit project status In Review" })
  expect(readProjectStatuses("a").statuses.at(-1)?.color).toBe("#4cb782")
  fireEvent.click(screen.getByRole("button", { name: "Actions for In Review" }))
  fireEvent.click(await screen.findByRole("menuitem", { name: "Move up" }))
  expect(
    readProjectStatuses("a").statuses.filter(
      (status) => status.group === "in-progress"
    )[0].name
  ).toBe("In Review")
  fireEvent.click(screen.getByRole("button", { name: "Actions for In Review" }))
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))
  await screen.findByRole("button", { name: "Deleted statuses (1)" })
  expect(readProjectStatuses("a").deleted[0].name).toBe("In Review")
  fireEvent.click(screen.getByRole("button", { name: "Deleted statuses (1)" }))
  fireEvent.click(screen.getByRole("button", { name: "Restore In Review" }))
  await screen.findByRole("button", { name: "Edit project status In Review" })
  expect(readProjectStatuses("a").deleted).toHaveLength(0)
})
it("rejects duplicate names, keeps an unsaved edit on a storage failure and cancels cleanly", async () => {
  render(<ProjectStatusesSettings workspaceId="a" />)
  fireEvent.click(
    screen.getByRole("button", { name: "Edit project status To do" })
  )
  fireEvent.change(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Status name" }),
    {
      target: { value: "Backlog" },
    }
  )
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(screen.getByRole("alert").textContent).toContain("already exists")
  fireEvent.change(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Status name" }),
    {
      target: { value: "Planned work" },
    }
  )
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota")
  })
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Status name" }).value
  ).toBe("Planned work")
  expect(readProjectStatuses("a").statuses[1].name).toBe("To do")
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  await screen.findByRole("button", { name: "Edit project status To do" })
})
it("protects edits from another tab's workflow changes", () => {
  render(<ProjectStatusesSettings workspaceId="a" />)
  fireEvent.click(
    screen.getByRole("button", { name: "Edit project status To do" })
  )
  fireEvent.change(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Status name" }),
    {
      target: { value: "My draft" },
    }
  )
  writeProjectStatuses("a", 0, (current) =>
    saveProjectStatus(current, { ...current.statuses[1], name: "Other tab" })
  )
  fireEvent(
    window,
    new StorageEvent("storage", { key: projectStatusesStorageKey("a") })
  )
  fireEvent.click(screen.getByRole("button", { name: "Save" }))
  expect(screen.getByRole("alert").textContent).toContain("changed elsewhere")
  expect(readProjectStatuses("a").statuses[1].name).toBe("Other tab")
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Status name" }).value
  ).toBe("My draft")
})
it("disables destructive actions on the final status in a group", async () => {
  render(<ProjectStatusesSettings workspaceId="a" />)
  fireEvent.click(screen.getByRole("button", { name: "Actions for Backlog" }))
  const item = await screen.findByRole("menuitem", { name: "Delete" })
  expect(item.getAttribute("aria-disabled")).toBe("true")
})
it("preserves corrupt settings and disables edits while showing a recovery message", async () => {
  localStorage.setItem(projectStatusesStorageKey("a"), "broken")
  render(<ProjectStatusesSettings workspaceId="a" />)
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain("preserved")
  )
  expect(
    screen
      .getByRole("button", {
        name: "Create project status in Backlog",
      })
      .hasAttribute("disabled")
  ).toBe(true)
})
