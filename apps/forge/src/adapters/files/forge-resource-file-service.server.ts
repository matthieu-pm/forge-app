import "@tanstack/react-start/server-only"
import { DrizzleResourceFileStore } from "./drizzle-resource-file-store.server"
import { createFileBlobStore } from "./file-blob-store.server"
import type { FileBlobStore } from "@/application/files/blob-store"
import { ResourceFileService } from "@/application/files/resource-file-service.server"
import { ApplicationAccessError } from "@/application/authorization"
import { getPlanningResource } from "@/application/planning/queries.server"
import {
  requireCurrentActor,
  requireResourceScope,
} from "@/application/resource-policy.server"
import { assertWorkspaceUploadAllowed } from "@/application/workspace-security/workspace-security.server"

/** Production composition uses FOR-39's live session, credential and resource policy. */
export function createForgeResourceFileService(
  blobs: FileBlobStore = createFileBlobStore()
) {
  return new ResourceFileService({
    metadata: new DrizzleResourceFileStore(),
    blobs,
    authorize: async (actor, resource, action) => {
      actor = await requireCurrentActor(actor)
      if (action === "write" && resource.kind === "issue")
        requireResourceScope(actor, "issues:write")
      // The canonical query can return null even though its indexed row type is inferred as non-null.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!(await getPlanningResource(actor, resource.kind, resource.id)))
        throw new ApplicationAccessError()
    },
    authorizeUpload: assertWorkspaceUploadAllowed,
  })
}
