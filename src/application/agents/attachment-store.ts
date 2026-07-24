import type { AgentAttachmentRecord } from "@/application/agents/attachment-contract"

export type StoredAgentAttachmentRecord = AgentAttachmentRecord & {
  workspaceId: string
  userId: string
  storageReference: string
  deletedAt: Date | null
}

export interface AgentAttachmentMetadataStore {
  create: (
    input: StoredAgentAttachmentRecord
  ) => Promise<StoredAgentAttachmentRecord>
  getAuthorized: (
    workspaceId: string,
    userId: string,
    ids: ReadonlyArray<string>
  ) => Promise<Array<StoredAgentAttachmentRecord>>
  listExpired: (
    before: Date,
    limit: number
  ) => Promise<Array<StoredAgentAttachmentRecord>>
  markDeleted: (
    attachmentId: string,
    deletedAt: Date
  ) => Promise<StoredAgentAttachmentRecord | null>
}
