import type { InitiativeProject } from "@/lib/initiatives"

/** Server and delivery policy share the exact post ownership projection. */
export function projectPostAttachments(properties: Record<string, unknown>) {
  const value = properties as Partial<InitiativeProject>
  return [
    ...(value.updates ?? []),
    ...(value.comments ?? []),
    ...(value.updates ?? []).flatMap((e) => e.comments ?? []),
    ...(value.comments ?? []).flatMap((e) => e.comments ?? []),
  ].flatMap((post) =>
    (post.attachments ?? []).flatMap((file) =>
      file.fileId
        ? [{ postId: post.id, fileId: file.fileId, attachment: file }]
        : []
    )
  )
}

export function projectPostFiles(properties: Record<string, unknown>) {
  return projectPostAttachments(properties).map(({ postId, fileId }) => ({
    postId,
    fileId,
  }))
}
