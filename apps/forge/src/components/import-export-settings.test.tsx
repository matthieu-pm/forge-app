import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ImportExportSettings } from "./import-export-settings"

const effects = vi.hoisted(() => ({ success: vi.fn(), fetch: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: effects.success } }))
vi.mock("./legacy-import-execution", () => ({
  LegacyImportExecution: () => <p>Browser data recovery</p>,
}))
vi.mock("./legacy-import-preview", () => ({ LegacyImportPreview: () => null }))
afterEach(cleanup)

describe("FOR-103 import/export availability", () => {
  it("preserves real browser recovery without offering a fictional external job", async () => {
    render(<ImportExportSettings />)
    expect(await screen.findByText("Browser data recovery")).toBeTruthy()
    const button = screen.getByRole("button", {
      name: "Export unavailable",
    })
    expect(button.hasAttribute("disabled")).toBe(true)
    fireEvent.click(button)
    expect(effects.success).not.toHaveBeenCalled()
    expect(screen.getByText(/no download email will be sent/)).toBeTruthy()
    expect(screen.queryByRole("link")).toBeNull()
    expect(
      screen
        .getByRole("button", {
          name: "External imports unavailable",
        })
        .hasAttribute("disabled")
    ).toBe(true)
  })
})
