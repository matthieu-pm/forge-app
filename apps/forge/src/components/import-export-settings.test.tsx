import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ImportExportSettings } from "./import-export-settings"

// The preview has its own interaction suite. Keep this controls-only test from
// starting a real lazy server-function import during environment teardown.
vi.mock("./legacy-import-preview", () => ({ LegacyImportPreview: () => null }))

describe("ImportExportSettings", () => {
  it("renders the import sources and export controls from the reference", async () => {
    render(<ImportExportSettings />)

    expect(
      screen.getByRole("heading", { name: "Import & export", level: 1 })
    ).toBeTruthy()

    for (const source of ["Asana", "Shortcut", "GitHub", "Jira", "Linear"]) {
      expect(screen.getByRole("button", { name: source })).toBeTruthy()
    }

    const cliLink = screen.getByRole("button", { name: "Open" })
    expect(cliLink.getAttribute("href")).toBe(
      "https://github.com/linear/linear/tree/master/packages/import"
    )

    const privateTeams = screen.getByRole("button", {
      name: "Include private teams",
    })
    expect(privateTeams.textContent).toContain("None")

    fireEvent.click(privateTeams)
    fireEvent.click(await screen.findByText("All private teams"))

    expect(privateTeams.textContent).toContain("All private teams")
    expect(screen.getByRole("button", { name: "Export…" })).toBeTruthy()
  })
})
