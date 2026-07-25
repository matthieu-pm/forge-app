import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@tanstack/react-router", async () => {
  const React = await import("react")

  return {
    Link: React.forwardRef<
      HTMLAnchorElement,
      React.ComponentProps<"a"> & { to: string }
    >(function MockLink({ to, ...props }, ref) {
      return <a ref={ref} href={to} {...props} />
    }),
    useRouter: () => ({
      invalidate: vi.fn(),
      navigate: vi.fn(),
    }),
  }
})

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    organization: {
      delete: vi.fn(),
      update: vi.fn(),
    },
  },
}))

import { WorkspaceSettings } from "./workspace-settings"

afterEach(cleanup)

const workspace = {
  id: "workspace-1",
  name: "Wondertale",
  slug: "wondertale",
  logo: null,
}

describe("WorkspaceSettings", () => {
  it("uses settings buttons for region and enterprise actions", () => {
    render(<WorkspaceSettings workspace={workspace} />)

    expect(
      screen.getByRole("button", { name: "European Union" })
    ).toBeTruthy()

    const enterpriseLinks = screen.getAllByRole("button", {
      name: "Available on Enterprise",
    })
    expect(enterpriseLinks).toHaveLength(2)
    for (const link of enterpriseLinks) {
      expect(link.getAttribute("href")).toBe("/settings/billing")
    }
  })

  it("exposes one workspace logo upload action", () => {
    render(<WorkspaceSettings workspace={workspace} />)

    expect(
      screen.getAllByRole("button", { name: "Upload workspace logo" })
    ).toHaveLength(1)
  })
})
