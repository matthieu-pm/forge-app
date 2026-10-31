import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import { DrizzleAgentArtifactStore } from "../agents/drizzle-artifact-store.server"
import { DrizzleAgentAttachmentStore } from "../agents/drizzle-attachment-store.server"
import { DrizzleResourceFileStore } from "./drizzle-resource-file-store.server"
import type { AuthorizedFileLookup } from "@/application/files/file-delivery-service.server"
import { db, fileUploadIntents, issues } from "@/db"
import { requireCurrentActor } from "@/application/resource-policy.server"
import { getPlanningResource } from "@/application/planning/queries.server"
import { requireAgentRead } from "@/application/agents/agent-authorization"

const resources = new DrizzleResourceFileStore()
const artifacts = new DrizzleAgentArtifactStore()
const attachments = new DrizzleAgentAttachmentStore()

export const lookupAuthorizedFile: AuthorizedFileLookup = async (
  actor,
  target
) => {
  actor = await requireCurrentActor(actor)
  if (target.kind === "resources") {
    const file = await resources.get(actor.workspaceId, target.id)
    if (
      !file ||
      file.deletedAt ||
      // The canonical query returns null for invisible resources despite its inferred row type.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      !(await getPlanningResource(actor, file.resource.kind, file.resource.id))
    )
      return null
    // Old processes can finalize uploads during an additive migration rollout.
    // A NULL state on a direct issue upload is still unbound, never a legacy grant.
    const directUpload =
      file.resource.kind === "issue" && !file.attachmentState
        ? (
            await db
              .select({ id: fileUploadIntents.id })
              .from(fileUploadIntents)
              .where(
                and(
                  eq(fileUploadIntents.id, file.id),
                  eq(fileUploadIntents.workspaceId, actor.workspaceId)
                )
              )
          ).at(0)
        : undefined
    if (file.attachmentState || directUpload) {
      if (file.attachmentState !== "attached" || file.resource.kind !== "issue")
        return null
      const [issue] = await db
        .select({ properties: issues.properties })
        .from(issues)
        .where(
          and(
            eq(issues.workspaceId, actor.workspaceId),
            eq(issues.id, file.resource.id)
          )
        )
      if (!issue) return null
      const comment = file.commentId
        ? issue.properties.comments?.find((c) => c.id === file.commentId)
        : null
      if (file.commentId && (!comment || comment.deleted)) return null
      const files = file.commentId
        ? comment?.attachments
        : issue.properties.attachments
      if (!files?.some((f) => f.fileId === file.id)) return null
    }
    return file
  }
  requireAgentRead(actor)
  const file =
    target.kind === "artifacts"
      ? await artifacts.getAuthorized(
          actor.workspaceId,
          actor.userId,
          target.id
        )
      : (
          await attachments.getAuthorized(actor.workspaceId, actor.userId, [
            target.id,
          ])
        )[0]
  if (!file || file.deletedAt) return null
  const expiry = "expiresAt" in file ? file.expiresAt : file.retentionExpiresAt
  if (expiry && expiry <= new Date()) return null
  return file
}
