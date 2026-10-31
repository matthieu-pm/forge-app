import "@tanstack/react-start/server-only"
import { and, eq, isNull, sql } from "drizzle-orm"
import type { Transaction } from "@/db"
import type { NotificationType } from "@/lib/notification-preferences-contract"
import { accountPreferences, issues, members } from "@/db"
import { readableIssueCondition } from "@/application/resource-policy.server"
import { decodeAccountPreferences } from "@/lib/account-preference-contract"
import { notificationChannels } from "@/lib/notification-preferences-contract"
import { issueSubscriberIds } from "@/lib/issue-engagement-contract"

export type IssueNotificationEvent = {
  workspaceId: string
  issueId: string
  actorId: string
} & (
  | { kind: "assignments" | "mentions"; recipientId: string }
  | { kind: "comments" | "replies" | "status" | "issue-updates" | "reactions" }
)
/** Internal delivery contract for FOR-65. Call with a COMMITTED server event and
 * each candidate recipient immediately before delivery. Never expose this as a
 * client recipient-selection endpoint. Membership/access/settings are live.
 * Channel settings control external alerts, not whether an inbox entry exists.
 */
export async function issueNotificationEligibility(
  tx: Transaction,
  event: IssueNotificationEvent,
  userId: string
) {
  const denied = {
    inbox: false,
    channels: [] as Array<(typeof notificationChannels)[number]>,
  }
  if (userId === event.actorId) return denied
  const direct = event.kind === "assignments" || event.kind === "mentions"
  if (direct && event.recipientId !== userId) return denied
  const row = (
    await tx
      .select({
        subscribers: sql<string>`coalesce(${issues.properties}->>'subscribers', '')`,
        values: accountPreferences.values,
      })
      .from(issues)
      .innerJoin(
        members,
        and(
          eq(members.organizationId, event.workspaceId),
          eq(members.userId, userId)
        )
      )
      .leftJoin(accountPreferences, eq(accountPreferences.userId, userId))
      .where(
        and(
          eq(issues.id, event.issueId),
          eq(issues.workspaceId, event.workspaceId),
          isNull(issues.archivedAt),
          readableIssueCondition(
            { workspaceId: event.workspaceId, userId },
            issues.id
          )
        )
      )
  )[0]
  if (
    !row ||
    (!direct && !issueSubscriberIds(row.subscribers).includes(userId))
  )
    return denied
  const preferences = decodeAccountPreferences(row.values ?? {}).notifications
  const kind: NotificationType = event.kind
  return {
    inbox: true,
    channels: notificationChannels.filter((channel) => {
      const setting = preferences.channels[channel]
      return (
        setting.enabled &&
        setting.types.includes(kind) &&
        (direct || setting.types.includes("subscriptions"))
      )
    }),
  }
}
