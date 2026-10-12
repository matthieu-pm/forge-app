// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { IntegrationsSettings } from "./integrations-settings"

import {
  getIntegrationLogoPath,
  integrationCategories,
} from "@/lib/integration-catalog"

afterEach(cleanup)

describe("Integrations settings", () => {
  it("renders enabled integrations and the catalog categories", () => {
    render(<IntegrationsSettings />)

    expect(screen.getByRole("heading", { name: "Integrations" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Enabled" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Essentials" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "AI clients" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Engineering" })).toBeTruthy()
    expect(
      document.querySelector('img[src="/img/integrations/github.svg"]')
    ).toBeTruthy()
    expect(
      document.querySelector('img[src="/img/integrations/slack.svg"]')
    ).toBeTruthy()
  })

  it("uses a local brand asset for every catalog integration", () => {
    const integrations = integrationCategories.flatMap(
      (category) => category.integrations
    )

    expect(integrations).toHaveLength(65)
    expect(integrations.every((integration) => getIntegrationLogoPath(integration)))
      .toBe(true)
  })

  it("filters integrations by name and description", () => {
    render(<IntegrationsSettings />)

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search integrations" }),
      {
        target: { value: "Claude" },
      }
    )

    expect(screen.getByText("2 integrations found")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "View Claude integration" })
    ).toBeTruthy()
    expect(screen.queryByRole("heading", { name: "Essentials" })).toBeNull()
  })

  it("switches the featured integration", () => {
    render(<IntegrationsSettings />)

    fireEvent.click(screen.getByRole("tab", { name: "Figma" }))

    expect(
      screen.getByRole("tab", { name: "Figma" }).getAttribute("aria-selected")
    ).toBe("true")
    expect(
      screen.getAllByRole("button", { name: "View Figma integration" })
    ).toHaveLength(2)
  })

  it("opens a detail dialog without performing a connection", () => {
    render(<IntegrationsSettings />)

    fireEvent.click(
      screen.getAllByRole("button", { name: "View GitLab integration" })[0]
    )

    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(
      screen.getByText(
        "Connection setup is not available in this preview. No external account will be changed."
      )
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Connect unavailable" })
    ).toBeTruthy()
  })
})
