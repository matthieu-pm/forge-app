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

export interface AgentArtifactBlobStore {
  put: (reference: string, content: Uint8Array) => Promise<void>
  get: (reference: string) => Promise<Uint8Array | null>
  delete: (reference: string) => Promise<void>
}
