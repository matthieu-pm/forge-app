import type { AgentArtifactRecord } from "@/application/agents/artifact-contract"

export type StoredAgentArtifactRecord = AgentArtifactRecord & {
  storageReference: string
}

export interface AgentArtifactMetadataStore {
  create: (
    input: StoredAgentArtifactRecord
  ) => Promise<StoredAgentArtifactRecord>
  findByRunChecksumAndName: (
    runId: string,
    checksum: string,
    name: string
  ) => Promise<StoredAgentArtifactRecord | null>
  getAuthorized: (
    workspaceId: string,
    userId: string,
    artifactId: string
  ) => Promise<StoredAgentArtifactRecord | null>
  listExpired: (
    before: Date,
    limit: number
  ) => Promise<Array<StoredAgentArtifactRecord>>
  markDeleted: (
    artifactId: string,
    deletedAt: Date
  ) => Promise<StoredAgentArtifactRecord | null>
}

/** @deprecated Use the shared file storage interface. */
export type { FileBlobStore as AgentArtifactBlobStore } from "@/application/files/blob-store"
