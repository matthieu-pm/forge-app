import * as React from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { IssueItems, Milestones } from "./template-items"
import { FormBuilder } from "./form-builder"
import type { TemplateDraft, TemplateItem } from "@/lib/template-contract"
import type { TeamSummary } from "@/lib/team-contract"

vi.mock("./rich-editor", () => ({
  RichEditor: () => null,
  insertFiles: vi.fn(),
}))
vi.mock("@/components/team-sidebar-icon", () => ({
  TeamSidebarIcon: () => null,
}))
afterEach(cleanup)
const team = {
  id: "team-1",
  slug: "testing",
  name: "Testing",
  identifier: "TST",
} as TeamSummary
const directory = {
  teams: [team],
  members: [],
  templates: [],
  defaults: { members: null, nonMembers: null },
  canManage: true,
}
function MilestoneHarness() {
  const [items, change] = React.useState<TemplateDraft["milestones"]>([])
  const [creating, setCreating] = React.useState(false)
  return (
    <Milestones
      items={items}
      onChange={change}
      creating={creating}
      onCreatingChange={setCreating}
    />
  )
}
function IssueHarness() {
  const [items, change] = React.useState<Array<TemplateItem>>([])
  const [creating, setCreating] = React.useState(true)
  return (
    <IssueItems
      team={team}
      directory={directory}
      items={items}
      onChange={change}
      creating={creating}
      onCreatingChange={setCreating}
    />
  )
}
function FormHarness() {
  const [fields, change] = React.useState<TemplateDraft["fields"]>([])
  return <FormBuilder fields={fields} onChange={change} />
}
describe("Nested template drafts", () => {
  it("creates and edits a milestone, then starts a fresh draft after cancellation", () => {
    render(<MilestoneHarness />)
    fireEvent.click(screen.getByRole("button", { name: "Add milestone" }))
    fireEvent.change(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Milestone name" }),
      {
        target: { value: "Scope approved" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Add milestone" }))
    fireEvent.click(screen.getByRole("button", { name: "Scope approved" }))
    fireEvent.change(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Milestone name" }),
      {
        target: { value: "Changed draft" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(screen.getByRole("button", { name: "Add milestone" }))
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "Milestone name",
      }).value
    ).toBe("")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByRole("button", { name: "Scope approved" })).toBeTruthy()
  })
  it("creates consecutive issues with create-more enabled", () => {
    render(<IssueHarness />)
    fireEvent.click(screen.getByRole("switch"))
    fireEvent.change(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Issue title" }),
      {
        target: { value: "Review brief" },
      }
    )
    fireEvent.click(
      screen.getAllByRole("button", { name: "Add issue" }).at(-1)!
    )
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Issue title" })
        .value
    ).toBe("")
    fireEvent.change(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Issue title" }),
      {
        target: { value: "Approve scope" },
      }
    )
    fireEvent.click(
      screen.getAllByRole("button", { name: "Add issue" }).at(-1)!
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(screen.getByRole("button", { name: "Review brief" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Approve scope" })).toBeTruthy()
  })
  it("builds, previews, reorders, and removes form fields", () => {
    render(<FormHarness />)
    fireEvent.click(screen.getByRole("button", { name: "Add field" }))
    fireEvent.change(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Field 1 label" }),
      {
        target: { value: "Repro steps" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Add field" }))
    fireEvent.change(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Field 2 label" }),
      {
        target: { value: "Platform" },
      }
    )
    fireEvent.click(screen.getByRole("button", { name: "Move field 2 up" }))
    fireEvent.click(screen.getByRole("button", { name: "Preview form" }))
    expect(
      screen.getByRole<HTMLInputElement>("textbox", { name: "Repro steps" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Edit fields" }))
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "Field 1 label",
      }).value
    ).toBe("Platform")
    fireEvent.click(screen.getByRole("button", { name: "Remove field 1" }))
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "Field 1 label",
      }).value
    ).toBe("Repro steps")
  })
})
