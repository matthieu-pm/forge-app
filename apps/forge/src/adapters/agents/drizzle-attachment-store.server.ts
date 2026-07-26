import "@tanstack/react-start/server-only"

import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm"

import type {
  AgentAttachmentMetadataStore,
  StoredAgentAttachmentRecord,
} from "@/application/agents/attachment-store"
import { agentAttachments, db } from "@/db"

function toRecord(
  attachment: typeof agentAttachments.$inferSelect
): StoredAgentAttachmentRecord {
  return attachment
}

export class DrizzleAgentAttachmentStore implements AgentAttachmentMetadataStore {
  async create(input: StoredAgentAttachmentRecord) {
    const rows = await db.insert(agentAttachments).values(input).returning()
    const attachment = rows.at(0)
    if (!attachment) throw new Error("The attachment metadata was not stored.")
    return toRecord(attachment)
  }

  async getAuthorized(
    workspaceId: string,
    userId: string,
    ids: ReadonlyArray<string>
  ) {
    if (ids.length === 0) return []
    const rows = await db
      .select()
      .from(agentAttachments)
      .where(
        and(
          eq(agentAttachments.workspaceId, workspaceId),
          eq(agentAttachments.userId, userId),
          inArray(agentAttachments.id, [...ids]),
          isNull(agentAttachments.deletedAt)
        )
      )
    return rows.map(toRecord)
  }

  async listExpired(before: Date, limit: number) {
    const rows = await db
      .select()
      .from(agentAttachments)
      .where(
        and(
          isNull(agentAttachments.deletedAt),
          lte(agentAttachments.expiresAt, before)
        )
      )
      .orderBy(asc(agentAttachments.expiresAt))
      .limit(limit)
    return rows.map(toRecord)
  }

  async markDeleted(attachmentId: string, deletedAt: Date) {
    const rows = await db
      .update(agentAttachments)
      .set({ deletedAt })
      .where(
        and(
          eq(agentAttachments.id, attachmentId),
          isNull(agentAttachments.deletedAt)
        )
      )
      .returning()
    const attachment = rows.at(0)
    return attachment ? toRecord(attachment) : null
  }
}
