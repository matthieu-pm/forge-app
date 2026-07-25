import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { ApplicationsSettings } from "./applications-settings"

describe("ApplicationsSettings", () => {
  afterEach(cleanup)

  it("shows the authorized applications from the reference", () => {
    render(<ApplicationsSettings />)

    expect(screen.getByRole("heading", { name: "Applications" })).toBeTruthy()
    expect(screen.getByText("MCP")).toBeTruthy()
    expect(screen.getByText("Notion")).toBeTruthy()
    expect(screen.getAllByText("Authorized by 1 member")).toHaveLength(2)
    expect(
      screen.getByRole("link", { name: "Docs ↗" }).getAttribute("target")
    ).toBe("_blank")
  })

  it("opens application settings from a row", () => {
    render(<ApplicationsSettings />)

    fireEvent.click(
      screen.getByRole("button", { name: "Edit settings for MCP" })
    )

    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByRole("heading", { name: "MCP settings" })).toBeTruthy()
    expect(screen.getByText("Workspace")).toBeTruthy()
  })
})
