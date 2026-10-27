import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { ProjectInitiativePicker } from "./project-initiative-picker"
import { InitiativePropertyPicker } from "@/components/initiatives/initiative-properties"
import { blankInitiative } from "@/lib/initiatives"

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const initiative = {
  ...blankInitiative("user"),
  id: "initiative",
  number: 1,
  name: "Growth",
}
function InitiativePicker() {
  const [value, onChange] = useState<Array<string>>([])
  return (
    <ProjectInitiativePicker
      detail
      initiatives={[initiative]}
      value={value}
      onChange={onChange}
    />
  )
}
it("uses a text prompt when empty and a plus-only trigger when linked, while preserving selection and removal", () => {
  render(<InitiativePicker />)
  const trigger = screen.getByRole("button", {
    name: "Change project initiatives",
  })
  expect(trigger.textContent).toBe("Add initiative…")
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole("option", { name: "Growth" }))
  expect(trigger.textContent).toBe("")
  fireEvent.click(screen.getByRole("option", { name: "Growth" }))
  expect(trigger.textContent).toBe("Add initiative…")
})
function LabelsPicker() {
  const [labelIds, setLabels] = useState<Array<string>>([])
  return (
    <InitiativePropertyPicker
      detail
      addOnly
      item={{ ...initiative, labelIds }}
      property="labels"
      people={[]}
      teams={[]}
      labels={[
        {
          id: "label",
          name: "Feature",
          color: "#5e6ad2",
          description: "",
          groupId: null,
          issues: 0,
          lastApplied: null,
          createdAt: "2026-10-27T10:00:00.000Z",
        },
      ]}
      onChange={(patch) => setLabels(patch.labelIds ?? [])}
    />
  )
}
it("shows selected labels beside a plus-only button and restores the empty label prompt when cleared", () => {
  render(<LabelsPicker />)
  fireEvent.click(
    screen.getByRole("button", { name: "Change labels for Growth" })
  )
  fireEvent.click(screen.getByRole("option", { name: "Feature" }))
  expect(
    screen.getByRole("button", { name: "Change labels for Growth" }).textContent
  ).toBe("")
  expect(screen.getAllByText("Feature").length).toBeGreaterThan(1)
  fireEvent.click(screen.getByRole("option", { name: "Feature" }))
  expect(
    screen.getByRole("button", { name: "Change labels for Growth" }).textContent
  ).toBe("Add label")
})
