// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ProjectUpdatesSettings } from "./project-updates-settings"
import { productStorage } from "@/lib/product-storage"
import {
  readProjectUpdatesSettings,
  writeProjectUpdatesSettings,
} from "@/lib/project-updates-settings"

beforeEach(() => productStorage.clear())
afterEach(cleanup)

describe("Project updates settings", () => {
  it("renders the saved schedule and Slack notification row", () => {
    render(<ProjectUpdatesSettings workspaceId="workspace-one" />)

    expect(
      screen.getByRole("heading", { name: "Project updates" })
    ).toBeTruthy()
    expect(screen.getByText("No expectation for updates")).toBeTruthy()
    expect(screen.getByText("#notifications")).toBeTruthy()
    expect(screen.getByText("Connected")).toBeTruthy()
  })

  it("opens editing and cancels without changing the saved value", async () => {
    writeProjectUpdatesSettings("workspace-one", { schedule: "2-weeks" })
    render(<ProjectUpdatesSettings workspaceId="workspace-one" />)

    expect(await screen.findByText("Every 2 weeks")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    expect(
      screen.getByRole("combobox", { name: "Project update schedule" })
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(screen.queryByRole("combobox")).toBeNull()
    expect(readProjectUpdatesSettings("workspace-one").schedule).toBe("2-weeks")
  })

  it("saves a selected update cadence", async () => {
    render(<ProjectUpdatesSettings workspaceId="workspace-one" />)
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    const schedule = screen.getByRole("combobox", {
      name: "Project update schedule",
    })
    fireEvent.click(schedule)
    const everyWeek = await screen.findByRole("option", { name: "Every week" })
    fireEvent.pointerDown(everyWeek)
    fireEvent.pointerUp(everyWeek)
    fireEvent.click(everyWeek)
    await waitFor(() => expect(schedule.textContent).toContain("Every week"))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(readProjectUpdatesSettings("workspace-one").schedule).toBe(
        "1-week"
      )
    )
    expect(screen.getByText("Every week")).toBeTruthy()
  })

  it("keeps update schedules isolated per workspace", async () => {
    writeProjectUpdatesSettings("workspace-one", { schedule: "4-weeks" })
    const view = render(<ProjectUpdatesSettings workspaceId="workspace-one" />)

    expect(await screen.findByText("Every 4 weeks")).toBeTruthy()
    view.rerender(<ProjectUpdatesSettings workspaceId="workspace-two" />)
    expect(await screen.findByText("No expectation for updates")).toBeTruthy()
  })
})
