import { describe, expect, it } from "vitest"
import { resolveSignalScope, sampleSignalAccounts } from "./signals-accounts"

describe("Signals account and project scope", () => {
  it("supports multiple accounts from the same provider", () => {
    const posthog = sampleSignalAccounts.filter(
      (account) => account.provider === "PostHog"
    )
    expect(posthog.length).toBeGreaterThan(1)
    expect(new Set(posthog.map((account) => account.id)).size).toBe(
      posthog.length
    )
  })

  it("retains a project only if it belongs to the selected account", () => {
    const { account, project } = resolveSignalScope(
      "studio-posthog",
      "acme-portal"
    )
    expect(account.id).toBe("studio-posthog")
    expect(project.id).toBe("studio-product")
  })

  it("allows project switching within an account", () => {
    const { project } = resolveSignalScope("acme-posthog", "acme-portal")
    expect(project.id).toBe("acme-portal")
    expect(project.seed).not.toBe(
      resolveSignalScope("acme-posthog").project.seed
    )
  })

  it("falls back to a valid account and project", () => {
    expect(resolveSignalScope("missing", "missing")).toEqual({
      account: sampleSignalAccounts[0],
      project: sampleSignalAccounts[0].projects[0],
    })
  })

  it("assigns independent sample histories to every project", () => {
    const projects = sampleSignalAccounts.flatMap((account) => account.projects)
    expect(new Set(projects.map((project) => project.seed)).size).toBe(
      projects.length
    )
  })
})
