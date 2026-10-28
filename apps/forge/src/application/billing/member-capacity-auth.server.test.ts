// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import {
  withMemberCapacityErrors,
  workspaceAuthMembershipLimit,
} from "./member-capacity-auth.server"
import { isWorkspaceMemberLimitError } from "./member-capacity-error"

const mocks = vi.hoisted(() => ({ entitlement: vi.fn() }))
vi.mock("./subscription-access-state.server", () => ({
  readSubscriptionAccessState: mocks.entitlement,
}))

type Factory = Parameters<typeof withMemberCapacityErrors>[0]
const capacityError = {
  code: "23514",
  constraint: "workspace_free_member_limit",
}

describe("workspace member capacity auth boundary", () => {
  it("recognizes only the named database invariant, including wrapped errors", () => {
    expect(isWorkspaceMemberLimitError(capacityError)).toBe(true)
    expect(
      isWorkspaceMemberLimitError({ cause: { cause: capacityError } })
    ).toBe(true)
    expect(
      isWorkspaceMemberLimitError({ message: "workspace_free_member_limit" })
    ).toBe(false)
    expect(
      isWorkspaceMemberLimitError({
        code: "23505",
        constraint: "workspace_free_member_limit",
      })
    ).toBe(false)
    expect(
      isWorkspaceMemberLimitError({
        code: "23514",
        constraint: "another_constraint",
      })
    ).toBe(false)
    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    expect(isWorkspaceMemberLimitError(cyclic)).toBe(false)
  })

  it("returns a public conflict for member creation and transaction failures", async () => {
    const create = vi.fn().mockRejectedValue({ cause: capacityError })
    const transaction = vi.fn().mockRejectedValue({ cause: capacityError })
    const factory = (() => ({ create, transaction })) as unknown as Factory
    const adapter = withMemberCapacityErrors(factory)({})
    await expect(
      adapter.create({ model: "member", data: {} })
    ).rejects.toMatchObject({
      status: "CONFLICT",
      body: { code: "WORKSPACE_MEMBER_LIMIT" },
    })
    await expect(
      adapter.transaction(() => Promise.resolve(null))
    ).rejects.toMatchObject({
      status: "CONFLICT",
      body: { code: "WORKSPACE_MEMBER_LIMIT" },
    })
  })

  it("preserves successful results and unrelated errors", async () => {
    const unknown = new Error("unrelated adapter failure")
    const create = vi
      .fn()
      .mockResolvedValueOnce({ id: "created" })
      .mockRejectedValueOnce(unknown)
    const transaction = vi.fn().mockResolvedValue("committed")
    const factory = (() => ({ create, transaction })) as unknown as Factory
    const adapter = withMemberCapacityErrors(factory)({})
    expect(await adapter.create({ model: "member", data: {} })).toEqual({
      id: "created",
    })
    await expect(adapter.create({ model: "member", data: {} })).rejects.toBe(
      unknown
    )
    expect(await adapter.transaction(() => Promise.resolve("committed"))).toBe(
      "committed"
    )
  })

  it.each([
    undefined,
    { plan: "free", status: "active" },
    { plan: "basic", status: "canceled" },
    { plan: "unknown", status: "active" },
  ])(
    "defaults unsupported/nonpaid state to the Free preflight limit: %j",
    async (row) => {
      mocks.entitlement.mockResolvedValueOnce(row)
      expect(await workspaceAuthMembershipLimit("w")).toBe(5)
    }
  )

  it.each(["basic", "business", "starter", "plus", "enterprise"])(
    "preserves server-confirmed %s capacity",
    async (plan) => {
      mocks.entitlement.mockResolvedValueOnce({ plan, status: "active" })
      expect(await workspaceAuthMembershipLimit("w")).toBe(
        Number.MAX_SAFE_INTEGER
      )
    }
  )
})
