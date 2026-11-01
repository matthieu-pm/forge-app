import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import { projectPostAttachments, projectPostFiles } from "./project-files"
import type { Transaction } from "@/db"
import type { Actor } from "@/application/actor"
import { resourceFiles } from "@/db"
import { ApplicationAccessError } from "@/application/authorization"

export async function bindProjectPostFiles(
  tx: Transaction,
  actor: Actor,
  projectId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>
) {
  const old = projectPostFiles(before),
    next = projectPostFiles(after)
  if (new Set(next.map((r) => r.fileId)).size !== next.length)
    throw new Error("Attach a file to only one project post.")
  const attachments = projectPostAttachments(after)
  for (const ref of [
    ...new Map(
      [...old, ...next].map((ref) => [`${ref.postId}:${ref.fileId}`, ref])
    ).values(),
  ]) {
    const file = (
      await tx
        .select()
        .from(resourceFiles)
        .where(
          and(
            eq(resourceFiles.workspaceId, actor.workspaceId),
            eq(resourceFiles.projectId, projectId),
            eq(resourceFiles.id, ref.fileId)
          )
        )
        .for("update")
    )[0]
    const previous = old.some(
        (r) => r.postId === ref.postId && r.fileId === ref.fileId
      ),
      wanted = next.some(
        (r) => r.postId === ref.postId && r.fileId === ref.fileId
      )
    if (
      !file ||
      file.deletedAt ||
      (!previous &&
        (file.createdByUserId !== actor.userId ||
          (file.attachmentState !== "unbound" &&
            !(
              file.attachmentState === "attached" &&
              file.projectPostId === ref.postId
            ))))
    )
      throw new ApplicationAccessError(
        "This project attachment is unavailable."
      )
    const attachment = attachments.find(
      (a) => a.postId === ref.postId && a.fileId === ref.fileId
    )?.attachment
    if (attachment)
      Object.assign(attachment, {
        id: file.id,
        name: file.name,
        mime: file.contentType,
        sizeBytes: file.sizeBytes,
      })
    await tx
      .update(resourceFiles)
      .set({
        attachmentState: wanted ? "attached" : "detached",
        projectPostId: ref.postId,
      })
      .where(eq(resourceFiles.id, ref.fileId))
  }
}
