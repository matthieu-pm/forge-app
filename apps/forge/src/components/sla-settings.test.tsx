// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SlaSettings } from "./sla-settings"
import { productStorage } from "@/lib/product-storage"
import { readSlaSettings } from "@/lib/sla-settings"

beforeEach(() => productStorage.clear())
afterEach(cleanup)

describe("SLA settings", () => {
  it("renders the disabled reference state by default", () => {
    render(<SlaSettings workspaceId="workspace-one" />)

    expect(screen.getByRole("heading", { name: "SLAs" })).toBeTruthy()
    expect(screen.getByText(/automatically apply deadlines/)).toBeTruthy()
    expect(
      screen
        .getByRole("switch", { name: "Enable SLAs" })
        .getAttribute("aria-checked")
    ).toBe("false")
    expect(screen.getByRole("button", { name: "Add rule" })).toHaveProperty(
      "disabled",
      true
    )
  })

  it("persists the workspace toggle and newly created rules", async () => {
    const view = render(<SlaSettings workspaceId="workspace-one" />)
    const toggle = screen.getByRole("switch", { name: "Enable SLAs" })

    fireEvent.click(toggle)
    await waitFor(() =>
      expect(readSlaSettings("workspace-one").enabled).toBe(true)
    )

    fireEvent.click(screen.getByRole("button", { name: "Add rule" }))
    fireEvent.change(screen.getByLabelText("Target time in hours"), {
      target: { value: "4" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(screen.getByText("Add SLA of 4 hours from escalation")).toBeTruthy()
    expect(readSlaSettings("workspace-one").rules.at(-1)).toMatchObject({
      priority: "urgent",
      action: "add",
      duration: "4 hours",
    })

    view.unmount()
    render(<SlaSettings workspaceId="workspace-one" />)
    await waitFor(() =>
      expect(
        screen.getByText("Add SLA of 4 hours from escalation")
      ).toBeTruthy()
    )
  })

  it("shows the reference work week and priority rules when enabled", async () => {
    render(<SlaSettings workspaceId="workspace-one" />)
    fireEvent.click(screen.getByRole("switch", { name: "Enable SLAs" }))

    expect(
      await screen.findByRole("combobox", { name: "Work week" })
    ).toBeTruthy()
    expect(screen.getAllByText("Priority")).toHaveLength(5)
    expect(screen.getByText("Add SLA of 24 hours from escalation")).toBeTruthy()
    expect(screen.getByText("Add SLA of 1 week from escalation")).toBeTruthy()
    expect(screen.getAllByText("Remove SLA")).toHaveLength(3)
  })

  it("keeps settings isolated per workspace", async () => {
    const view = render(<SlaSettings workspaceId="workspace-one" />)
    fireEvent.click(screen.getByRole("switch", { name: "Enable SLAs" }))
    await waitFor(() =>
      expect(readSlaSettings("workspace-one").enabled).toBe(true)
    )

    view.rerender(<SlaSettings workspaceId="workspace-two" />)
    await waitFor(() =>
      expect(
        screen
          .getByRole("switch", { name: "Enable SLAs" })
          .getAttribute("aria-checked")
      ).toBe("false")
    )
    expect(readSlaSettings("workspace-two").enabled).toBe(false)
  })
})
