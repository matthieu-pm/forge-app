import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { ActivityAuthor, ActivityDate } from "./activity-author"
import type { ComponentProps } from "react"
import type { InitiativeProject } from "@/lib/initiatives"

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    search: _search,
    ...props
  }: ComponentProps<"a"> & {
    to: string
    params: Record<string, string>
    search?: unknown
  }) => (
    <a
      href={to.replace(/\$(\w+)/g, (_, name: string) => params[name])}
      {...props}
    />
  ),
}))

afterEach(cleanup)

const project = (id: string, memberIds: Array<string>): InitiativeProject => ({
  id,
  name: id,
  memberIds,
  teamIds: [],
  status: "Active",
  health: "On track",
})

it("shows the author's actual profile, teams, and associated projects", async () => {
  render(
    <ActivityAuthor
      person={{
        id: "author",
        name: "Matthieu",
        username: "contact",
        isOnline: true,
        teams: [{ id: "team", slug: "skema", name: "SKEMA" }],
      }}
      userId="author"
      projects={[
        project("Member project", ["author"]),
        { ...project("Lead project", []), leadId: "author" },
        project("Unrelated project", ["someone-else"]),
      ]}
    />
  )
  fireEvent.click(
    screen.getByRole("button", { name: "View Matthieu's profile" })
  )
  const preview = within(
    await screen.findByRole("dialog", { name: "Member preview: Matthieu" })
  )
  expect(preview.getByText("contact")).toBeTruthy()
  expect(preview.getByText("Online")).toBeTruthy()
  expect(preview.getByText("local time")).toBeTruthy()
  expect(
    preview.getByRole("link", { name: "SKEMA" }).getAttribute("href")
  ).toBe("/teams/skema/issues")
  expect(preview.getByRole("link", { name: "Member project" })).toBeTruthy()
  expect(preview.getByRole("link", { name: "Lead project" })).toBeTruthy()
  expect(preview.queryByText("Unrelated project")).toBeNull()
})

it("omits unavailable presence and another member's local time", async () => {
  render(<ActivityAuthor person={{ id: "other", name: "Mateo" }} userId="me" />)
  fireEvent.click(screen.getByRole("button", { name: "View Mateo's profile" }))
  const preview = within(
    await screen.findByRole("dialog", { name: "Member preview: Mateo" })
  )
  expect(preview.queryByText("Online")).toBeNull()
  expect(preview.queryByText("Offline")).toBeNull()
  expect(preview.queryByText(/local time/)).toBeNull()
  expect(preview.queryByRole("link")).toBeNull()
})

it("handles former members and shows calendar dates with the full timestamp", () => {
  const { container } = render(
    <>
      <ActivityAuthor userId="me" />
      <ActivityDate value="2026-10-26T12:30:00.000Z" />
    </>
  )
  expect(screen.getByText("Former member")).toBeTruthy()
  expect(screen.queryByRole("button")).toBeNull()
  expect(screen.getByText("Oct 26")).toBeTruthy()
  expect(container.querySelector("time")?.dateTime).toBe(
    "2026-10-26T12:30:00.000Z"
  )
  expect(container.querySelector("time")?.title).toContain("2026")
})
