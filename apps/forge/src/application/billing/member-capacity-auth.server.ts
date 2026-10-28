import "@tanstack/react-start/server-only"
import { APIError } from "better-auth/api"
import { eq } from "drizzle-orm"
import {
  WORKSPACE_MEMBER_LIMIT_MESSAGE,
  isWorkspaceMemberLimitError,
} from "./member-capacity-error"
import { FREE_WORKSPACE_MEMBER_LIMIT } from "./billing-plan-contract"
import type { drizzleAdapter } from "@better-auth/drizzle-adapter"
import { db, workspaceEntitlements } from "@/db"

type AdapterFactory = ReturnType<typeof drizzleAdapter>

function throwCapacityError(error: unknown): never {
  if (isWorkspaceMemberLimitError(error))
    throw new APIError("CONFLICT", {
      code: "WORKSPACE_MEMBER_LIMIT",
      message: WORKSPACE_MEMBER_LIMIT_MESSAGE,
    })
  throw error
}

/** Keep provider errors actionable without exposing SQL or workspace data. */
export function withMemberCapacityErrors(
  factory: AdapterFactory
): AdapterFactory {
  return (options) => {
    const adapter = factory(options)
    return {
      ...adapter,
      async create(input) {
        try {
          return await adapter.create(input)
        } catch (error) {
          return throwCapacityError(error)
        }
      },
      async transaction(callback) {
        try {
          return await adapter.transaction(callback)
        } catch (error) {
          return throwCapacityError(error)
        }
      },
    }
  }
}

/** Better Auth preflight; the database trigger remains the race-safe authority. */
export async function workspaceAuthMembershipLimit(workspaceId: string) {
  const row = await db.query.workspaceEntitlements.findFirst({
    where: eq(workspaceEntitlements.workspaceId, workspaceId),
  })
  const paid =
    row &&
    ["active", "trialing"].includes(row.status) &&
    ["basic", "business", "starter", "plus", "enterprise"].includes(row.plan)
  return paid ? Number.MAX_SAFE_INTEGER : FREE_WORKSPACE_MEMBER_LIMIT
}
