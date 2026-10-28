import "@tanstack/react-start/server-only"
import { count, eq } from "drizzle-orm"
import { workspaceBillingIdentity } from "./billing-authority"
import { billableMemberCountSchema } from "./billing-plan-contract"
import type { Actor } from "@/application/actor"
import { db, members } from "@/db"

export async function countBillableWorkspaceMembers(actor: Actor) {
  const identity = workspaceBillingIdentity(actor)
  // Accepted membership lives in `member`; pending invitations are a separate
  // table. All accepted roles count, including owner/admin, irrespective of usage.
  const rows = await db
    .select({ total: count() })
    .from(members)
    .where(eq(members.organizationId, identity.workspaceId))
  return billableMemberCountSchema.parse(rows[0]?.total)
}
