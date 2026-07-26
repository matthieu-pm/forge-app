import "@tanstack/react-start/server-only"

import { z } from "zod"

import {
  CapabilityGateway,
  CapabilityRegistry,
  defineCapability,
} from "@/application/agents/capability-gateway.server"
import {
  teamSummarySchema,
  updateTeamInputSchema,
} from "@/application/teams/team-schemas"
import {
  getTeam,
  listTeams,
  updateTeam,
} from "@/application/teams/teams.server"
import { ApprovalService } from "@/application/agents/approval-service.server"
import { DrizzleAgentApprovalStore } from "@/adapters/agents/drizzle-approval-store.server"
import { DrizzleAgentEventStore } from "@/adapters/agents/drizzle-event-store.server"
import { DrizzleAgentStore } from "@/adapters/agents/drizzle-agent-store.server"
import { DrizzleCapabilityIdempotencyStore } from "@/adapters/agents/drizzle-capability-idempotency-store.server"
import {
  describeWorkspace,
  workspaceDescriptionSchema,
} from "@/application/workspaces/workspace.server"
import {
  agentArtifactRecordSchema,
  createAgentArtifactInputSchema,
} from "@/application/agents/artifact-contract"
import { AgentArtifactService } from "@/application/agents/artifact-service.server"
import { DrizzleAgentArtifactStore } from "@/adapters/agents/drizzle-artifact-store.server"
import { LocalArtifactBlobStore } from "@/adapters/agents/local-artifact-blob-store.server"
import { resolveAgentControlPolicy } from "@/application/agents/agent-control-policy"
import { AgentAttachmentService } from "@/application/agents/attachment-service.server"
import { DrizzleAgentAttachmentStore } from "@/adapters/agents/drizzle-attachment-store.server"

const listTeamsInputSchema = z
  .object({
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()

const teamPageSchema = z
  .object({
    items: z.array(teamSummarySchema),
    nextCursor: z.string().nullable(),
  })
  .strict()

const listTeamsCapability = defineCapability({
  descriptor: {
    id: "teams.list",
    version: "1",
    summary: "List teams in the actor's current Forge workspace.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: {
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        items: { type: "array" },
        nextCursor: { type: ["string", "null"] },
      },
      required: ["items", "nextCursor"],
    },
    maxResultBytes: 256 * 1024,
  },
  inputSchema: listTeamsInputSchema,
  outputSchema: teamPageSchema,
  execute: (actor, input) => listTeams(actor, input),
})

const getTeamInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    slug: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.id) !== Boolean(value.slug), {
    message: "Provide exactly one team id or slug.",
  })

const getTeamCapability = defineCapability({
  descriptor: {
    id: "teams.get",
    version: "1",
    summary: "Get one team by id or slug in the current Forge workspace.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        slug: { type: "string" },
      },
      additionalProperties: false,
    },
    outputSchema: {
      anyOf: [{ type: "object" }, { type: "null" }],
    },
    maxResultBytes: 64 * 1024,
  },
  inputSchema: getTeamInputSchema,
  outputSchema: teamSummarySchema.nullable(),
  execute: (actor, input) =>
    getTeam(actor, input.id ? { id: input.id } : { slug: input.slug! }),
})

const describeWorkspaceCapability = defineCapability({
  descriptor: {
    id: "workspace.describe",
    version: "1",
    summary: "Describe the actor's current Forge workspace.",
    risk: "read",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        slug: { type: "string" },
        actorRole: { type: "string" },
      },
      required: ["id", "name", "slug", "actorRole"],
    },
    maxResultBytes: 16 * 1024,
  },
  inputSchema: z.object({}).strict(),
  outputSchema: workspaceDescriptionSchema,
  execute: (actor) => describeWorkspace(actor),
})

const updateTeamCapability = defineCapability({
  descriptor: {
    id: "teams.update",
    version: "1",
    summary: "Update settings for an existing team in the current workspace.",
    risk: "reversible-write",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string" },
        settings: { type: "object" },
      },
      required: ["slug", "settings"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        slug: { type: "string" },
        identifier: { type: "string" },
        name: { type: "string" },
      },
      required: ["id", "slug", "identifier", "name"],
    },
    maxResultBytes: 64 * 1024,
  },
  inputSchema: updateTeamInputSchema,
  outputSchema: teamSummarySchema,
  execute: async (actor, input) => {
    const result = await updateTeam(actor, { slug: input.slug }, input.settings)
    if (!result.ok) throw new Error(result.message)
    return result.team
  },
})

const agentStore = new DrizzleAgentStore()
const eventStore = new DrizzleAgentEventStore()
const artifactBlobs = new LocalArtifactBlobStore()
export const forgeArtifactService = new AgentArtifactService({
  metadata: new DrizzleAgentArtifactStore(),
  blobs: artifactBlobs,
  agents: agentStore,
  events: eventStore,
})
export const forgeAttachmentService = new AgentAttachmentService({
  metadata: new DrizzleAgentAttachmentStore(),
  blobs: artifactBlobs,
})
const createArtifactCapability = defineCapability({
  descriptor: {
    id: "artifacts.create",
    version: "1",
    summary:
      "Persist a bounded file generated by this run for the user to download.",
    risk: "read",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["file", "text", "data", "report", "code"],
        },
        name: { type: "string", minLength: 1, maxLength: 200 },
        contentType: { type: "string", minLength: 1, maxLength: 120 },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        content: { type: "string" },
      },
      required: ["name", "contentType", "content"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        runId: { type: "string", format: "uuid" },
        name: { type: "string" },
        contentType: { type: "string" },
        sizeBytes: { type: "integer", minimum: 0 },
        checksum: { type: "string" },
      },
      required: [
        "id",
        "runId",
        "name",
        "contentType",
        "sizeBytes",
        "checksum",
      ],
    },
    maxResultBytes: 32 * 1024,
  },
  inputSchema: createAgentArtifactInputSchema,
  outputSchema: agentArtifactRecordSchema,
  execute: (actor, input, context) =>
    forgeArtifactService.create(actor, context.runId, input),
})
export const forgeApprovalService = new ApprovalService({
  approvals: new DrizzleAgentApprovalStore(),
  agents: agentStore,
  events: eventStore,
})

export const forgeCapabilityGateway = new CapabilityGateway(
  new CapabilityRegistry([
    listTeamsCapability,
    getTeamCapability,
    describeWorkspaceCapability,
    updateTeamCapability,
    createArtifactCapability,
  ]),
  {
    approvals: forgeApprovalService,
    idempotency: new DrizzleCapabilityIdempotencyStore(),
    allowedCapabilities: resolveAgentControlPolicy().allowedCapabilities,
  }
)
