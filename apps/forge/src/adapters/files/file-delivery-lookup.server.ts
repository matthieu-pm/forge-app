import "@tanstack/react-start/server-only"
import { DrizzleAgentArtifactStore } from "../agents/drizzle-artifact-store.server"
import { DrizzleAgentAttachmentStore } from "../agents/drizzle-attachment-store.server"
import { DrizzleResourceFileStore } from "./drizzle-resource-file-store.server"
import type { AuthorizedFileLookup } from "@/application/files/file-delivery-service.server"
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
