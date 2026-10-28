// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PgDialect } from "drizzle-orm/pg-core"
import { countBillableWorkspaceMembers } from "./billable-members.server"
import type { Actor } from "@/application/actor"

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  from: vi.fn(),
  where: vi.fn(),
}))
vi.mock("@/db", async () => ({
  ...(await import("@/db/auth-schema")),
  db: { select: mocks.select },
}))
const actor: Actor = {
  userId: "alice",
  workspaceId: "workspace-a",
  workspaceRole: "owner",
  authentication: { kind: "session", sessionId: "s" },
  scopes: null,
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.select.mockReturnValue({ from: mocks.from })
  mocks.from.mockReturnValue({ where: mocks.where })
  mocks.where.mockResolvedValue([{ total: 3 }])
})
describe("billable membership count", () => {
  it("counts accepted members of the authenticated workspace with no role/usage filter", async () => {
    expect(await countBillableWorkspaceMembers(actor)).toBe(3)
    const predicate = new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0])
    expect(predicate.params).toEqual(["workspace-a"])
    expect(predicate.sql).not.toContain("role")
    const schema = await import("@/db/auth-schema")
    expect(mocks.from).toHaveBeenCalledWith(schema.members)
  })
  it("does not query for a member without billing authority", async () => {
    await expect(
      countBillableWorkspaceMembers({ ...actor, workspaceRole: "member" })
    ).rejects.toThrow()
    expect(mocks.select).not.toHaveBeenCalled()
  })
})
