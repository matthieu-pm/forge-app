import "@tanstack/react-start/server-only"
import { APIError } from "better-auth/api"
import {
  WORKSPACE_MEMBER_LIMIT_MESSAGE,
  isWorkspaceMemberLimitError,
} from "./member-capacity-error"
import { FREE_WORKSPACE_MEMBER_LIMIT } from "./billing-plan-contract"
import { subscriptionAccess } from "./subscription-access"
import { readSubscriptionAccessState } from "./subscription-access-state.server"
import type { drizzleAdapter } from "@better-auth/drizzle-adapter"

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
  const row = await readSubscriptionAccessState(workspaceId)
  const paid = subscriptionAccess(row).plan !== "free"
  return paid ? Number.MAX_SAFE_INTEGER : FREE_WORKSPACE_MEMBER_LIMIT
}
