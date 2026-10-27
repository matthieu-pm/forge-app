import { useState } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { IssueLabelPicker } from "./issue-label-picker"
import type { ReactNode } from "react"

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))

function Example() {
  const [value, setValue] = useState("Bug")
  return (
    <>
      <output data-testid="selection">{value}</output>
      <IssueLabelPicker
        value={value}
        onChange={setValue}
        labels={["Feature", "Bug", "Improvement"]}
        colors={{ Bug: "#eb5757" }}
        issues={[]}
        team={{ slug: "testing", name: "Testing" }}
      />
    </>
  )
}
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("issue label picker", () => {
  it("groups selected labels first and keeps the picker open while adding and removing labels", async () => {
    render(<Example />)
    fireEvent.click(screen.getByRole("button", { name: "Change label Bug" }))
    const list = await screen.findByRole("listbox", { name: "Labels" })
    expect(
      within(list)
        .getAllByRole("option")
        .map((item) => item.textContent)
    ).toEqual(["Bug", "Feature", "Improvement"])
    expect(
      within(list)
        .getByRole("option", { name: "Bug" })
        .getAttribute("aria-selected")
    ).toBe("true")
    fireEvent.click(within(list).getByRole("option", { name: "Feature" }))
    expect(screen.getByTestId("selection").textContent).toBe("Bug, Feature")
    expect(screen.getByRole("listbox", { name: "Labels" })).toBeTruthy()
    fireEvent.click(within(list).getByRole("option", { name: "Bug" }))
    expect(screen.getByTestId("selection").textContent).toBe("Feature")
    expect(screen.getByRole("listbox", { name: "Labels" })).toBeTruthy()
    expect(document.activeElement?.textContent).toBe("Bug")
  })
  it("filters both groups and navigates the full option list with arrow keys", async () => {
    render(<Example />)
    fireEvent.click(screen.getByRole("button", { name: "Add labels" }))
    const input = await screen.findByRole("textbox", {
      name: "Change or add labels",
    })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(document.activeElement?.textContent).toBe("Bug")
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
    expect(document.activeElement?.textContent).toBe("Feature")
    fireEvent.change(input, { target: { value: "impro" } })
    expect(
      screen.getAllByRole("option").map((item) => item.textContent)
    ).toEqual(["Improvement"])
    fireEvent.keyDown(input, { key: "Enter" })
    expect(screen.getByTestId("selection").textContent).toBe("Bug, Improvement")
  })
  it("retains custom label entry without creating case-insensitive duplicates", async () => {
    render(<Example />)
    fireEvent.click(screen.getByRole("button", { name: "Add labels" }))
    const input = await screen.findByRole("textbox", {
      name: "Change or add labels",
    })
    fireEvent.change(input, { target: { value: "feature" } })
    expect(screen.queryByRole("button", { name: /Use/ })).toBeNull()
    fireEvent.change(input, { target: { value: "New label" } })
    fireEvent.click(screen.getByRole("button", { name: "Use “New label”" }))
    expect(screen.getByTestId("selection").textContent).toBe("Bug, New label")
  })
})
