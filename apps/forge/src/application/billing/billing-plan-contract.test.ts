import { describe, expect, it } from "vitest"
import {
  monthlyWorkspacePrice,
  pooledWorkspaceLimit,
  selfServePlanSchema,
  workspaceMemberCapacity,
} from "./billing-plan-contract"

describe("workspace member pricing and shared allowance", () => {
  it("allows the fifth Free member and rejects the sixth or a batch crossing the cap", () => {
    expect(workspaceMemberCapacity("free", 4)).toEqual({
      allowed: true,
      memberLimit: 5,
      projectedMembers: 5,
    })
    expect(workspaceMemberCapacity("free", 5).allowed).toBe(false)
    expect(workspaceMemberCapacity("free", 3, 3).allowed).toBe(false)
    expect(workspaceMemberCapacity("free", 0, 5).allowed).toBe(true)
    expect(workspaceMemberCapacity("free", 6).allowed).toBe(false)
  })
  it.each(["starter", "plus", "enterprise"] as const)(
    "does not impose the Free cap on %s",
    (plan) => {
      expect(workspaceMemberCapacity(plan, 5)).toEqual({
        allowed: true,
        memberLimit: null,
        projectedMembers: 6,
      })
    }
  )
  it("rejects invalid counts and cannot overflow a batch addition", () => {
    for (const count of [-1, 1.5, NaN, Infinity])
      expect(() => workspaceMemberCapacity("free", count)).toThrow()
    for (const count of [0, -1, 1.5, NaN, Infinity])
      expect(() => workspaceMemberCapacity("free", 1, count)).toThrow()
    expect(() =>
      workspaceMemberCapacity("plus", Number.MAX_SAFE_INTEGER)
    ).toThrow()
  })
  it("prices Starter at 10 and Plus at 16 per user monthly in either approved currency", () => {
    expect(monthlyWorkspacePrice("starter", 3)).toBe(3000)
    expect(monthlyWorkspacePrice("plus", 3)).toBe(4800)
    expect(monthlyWorkspacePrice("plus", 5)).toBe(8000)
  })
  it("scales the shared pool with billable membership", () => {
    // Fixture limits demonstrate arithmetic, not approved commercial allowances.
    expect(pooledWorkspaceLimit(100, 3)).toBe(300)
    expect(pooledWorkspaceLimit(100, 4)).toBe(400)
    expect(pooledWorkspaceLimit(0, 3)).toBe(0)
  })
  it("keeps Enterprise out of self-serve checkout", () => {
    expect(selfServePlanSchema.safeParse("enterprise").success).toBe(false)
    expect(selfServePlanSchema.safeParse("free").success).toBe(false)
  })
  it("rejects fractional, negative and overflowed counts or allowances", () => {
    for (const count of [0, -1, 1.5, Infinity]) {
      expect(() => monthlyWorkspacePrice("starter", count)).toThrow()
      expect(() => pooledWorkspaceLimit(100, count)).toThrow()
    }
    expect(() => pooledWorkspaceLimit(-1, 1)).toThrow()
    expect(() => pooledWorkspaceLimit(Number.MAX_SAFE_INTEGER, 2)).toThrow()
    expect(() =>
      monthlyWorkspacePrice("plus", Number.MAX_SAFE_INTEGER)
    ).toThrow()
  })
})
