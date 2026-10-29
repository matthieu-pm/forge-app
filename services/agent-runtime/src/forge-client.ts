import { observeOperation } from "../../../packages/telemetry/server.js"
import { stagingServiceFetch } from "../../../packages/environment/staging-service-auth.js"
import { z } from "zod"

const teamSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  identifier: z.string(),
  name: z.string(),
  timezone: z.string(),
  description: z.string(),
})

const teamPageSchema = z.object({
  items: z.array(teamSchema),
  nextCursor: z.string().nullable(),
})

const workspaceDescriptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  actorRole: z.string(),
})

const artifactSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  kind: z.enum(["file", "text", "data", "report", "code"]),
  name: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  checksum: z.string(),
  retentionExpiresAt: z.coerce.date().nullable(),
  deletedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
})

export type ForgeCaller = {
  workspaceId: string
  runId: string
  capabilityToken: string
  correlationId?: string
}

export async function callForgeCapability(
  caller: ForgeCaller,
  capability: {
    id: string
    version: string
    input: Record<string, unknown>
    idempotencyKey?: string
  },
  signal?: AbortSignal
) {
  return observeOperation(
    "runtime.callback",
    () => callCapability(caller, capability, signal),
    { runId: caller.runId, correlationId: caller.correlationId ?? caller.runId }
  )
}

async function callCapability(
  caller: ForgeCaller,
  capability: {
    id: string
    version: string
    input: Record<string, unknown>
    idempotencyKey?: string
  },
  signal?: AbortSignal
) {
  const origin = process.env.FORGE_APP_ORIGIN
  if (!origin) throw new Error("FORGE_APP_ORIGIN is not configured.")

  const response = await stagingServiceFetch(
    new URL(
      `/api/agent/capabilities/${encodeURIComponent(capability.id)}`,
      origin
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${caller.capabilityToken}`,
        "content-type": "application/json",
        "x-correlation-id": caller.correlationId ?? caller.runId,
        "x-forge-agent-run-id": caller.runId,
        "x-forge-workspace-id": caller.workspaceId,
      },
      body: JSON.stringify({
        version: capability.version,
        input: capability.input,
        idempotencyKey: capability.idempotencyKey,
      }),
      signal,
    }
  )
  if (!response.ok) {
    // Never surface an upstream private body through a tool error/log.
    throw new Error("Forge capability request failed.")
  }

  return (await response.json()) as unknown
}

export async function listForgeTeams(
  caller: ForgeCaller,
  input: { cursor?: string; limit: number },
  signal?: AbortSignal
) {
  const result = await callForgeCapability(
    caller,
    {
      id: "teams.list",
      version: "1",
      input,
    },
    signal
  )

  return teamPageSchema.parse(result)
}

export async function getForgeTeam(
  caller: ForgeCaller,
  input: { id?: string; slug?: string },
  signal?: AbortSignal
) {
  const result = await callForgeCapability(
    caller,
    {
      id: "teams.get",
      version: "1",
      input,
    },
    signal
  )
  return teamSchema.nullable().parse(result)
}

export async function describeForgeWorkspace(
  caller: ForgeCaller,
  signal?: AbortSignal
) {
  const result = await callForgeCapability(
    caller,
    {
      id: "workspace.describe",
      version: "1",
      input: {},
    },
    signal
  )
  return workspaceDescriptionSchema.parse(result)
}

export async function updateForgeTeam(
  caller: ForgeCaller,
  input: {
    slug: string
    settings: Record<string, unknown>
  },
  idempotencyKey: string,
  signal?: AbortSignal
) {
  const result = await callForgeCapability(
    caller,
    {
      id: "teams.update",
      version: "1",
      input,
      idempotencyKey,
    },
    signal
  )
  return teamSchema.parse(result)
}

export async function createForgeArtifact(
  caller: ForgeCaller,
  input: {
    kind: "file" | "text" | "data" | "report" | "code"
    name: string
    contentType: string
    encoding: "utf8" | "base64"
    content: string
  },
  signal?: AbortSignal
) {
  const result = await callForgeCapability(
    caller,
    {
      id: "artifacts.create",
      version: "1",
      input,
    },
    signal
  )
  return artifactSchema.parse(result)
}
