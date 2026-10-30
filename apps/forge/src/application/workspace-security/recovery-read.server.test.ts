// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { getWorkspaceSecuritySettings } from "./workspace-security.server"

vi.mock("@tanstack/react-start/server-only", () => ({}))
vi.mock("@/db", () => ({
  db: {},
  organizations: {},
  workspaceApprovedDomains: {},
  workspaceSecurityAuditEvents: {},
  workspaceSecuritySettings: { workspaceId: "workspace_id" },
}))
vi.mock("@/application/resource-policy.server", () => ({
  requireCurrentActor: vi.fn(),
}))
vi.mock("@/application/billing/subscription-access-state.server", () => ({
  readSubscriptionAccessState: vi.fn(),
}))

describe("policy reads during a recovery-journal outage", () => {
  function fixture() {
    const row = { restrictFileUploads: true, allowedUploadTypes: [] }
    const findFirst = vi.fn().mockResolvedValue(row)
    const onConflictDoNothing = vi.fn().mockResolvedValue(undefined)
    const insert = vi
      .fn()
      .mockReturnValue({ values: () => ({ onConflictDoNothing }) })
    const executor = {
      query: { workspaceSecuritySettings: { findFirst } },
      insert,
    }
    return {
      row,
      findFirst,
      insert,
      executor: executor as unknown as NonNullable<
        Parameters<typeof getWorkspaceSecuritySettings>[1]
      >,
    }
  }
  it("reads an existing policy without a journal-dependent insert", async () => {
    const f = fixture()
    expect(
      (await getWorkspaceSecuritySettings("workspace", f.executor))
        .restrictFileUploads
    ).toBe(true)
    expect(f.insert).not.toHaveBeenCalled()
  })
  it("creates only a missing policy and rereads after conflict resolution", async () => {
    const f = fixture()
    f.findFirst.mockResolvedValueOnce(undefined)
    await getWorkspaceSecuritySettings("workspace", f.executor)
    expect(f.insert).toHaveBeenCalledOnce()
    expect(f.findFirst).toHaveBeenCalledTimes(2)
  })
})
