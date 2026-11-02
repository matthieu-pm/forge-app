export type FileResource = {
  kind: "issue" | "document" | "project"
  id: string
}
export type StoredResourceFile = {
  id: string
  workspaceId: string
  createdByUserId: string
  resource: FileResource
  name: string
  contentType: string
  sizeBytes: number
  checksum: string
  storageReference: string
  createdAt: Date
  deletedAt: Date | null
  attachmentState?: "unbound" | "attached" | "detached" | null
  projectPostId?: string | null
  commentId?: string | null
}
export interface ResourceFileMetadataStore {
  create: (record: StoredResourceFile) => Promise<StoredResourceFile>
  get: (
    workspaceId: string,
    fileId: string
  ) => Promise<StoredResourceFile | null>
}
