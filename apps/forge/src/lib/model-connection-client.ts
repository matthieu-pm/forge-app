import type {
  CreateModelConnectionInput,
  ModelConnectionSummary,
} from "@/application/agents/model-connection-contract"
import { modelConnectionSummarySchema } from "@/application/agents/model-connection-contract"

async function readResponse<T>(
  response: Response,
  parse: (value: unknown) => T
) {
  const payload = (await response.json()) as unknown
  if (!response.ok) {
    const message =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : "The model connection request failed."
    throw new Error(message)
  }
  return parse(payload)
}

export async function listModelConnections() {
  const response = await fetch("/api/agent/connections", {
    headers: { accept: "application/json" },
  })
  return readResponse(response, (value) =>
    modelConnectionSummarySchema.array().parse(value)
  )
}

export async function createModelConnection(input: CreateModelConnectionInput) {
  const response = await fetch("/api/agent/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
  return readResponse(response, (value) =>
    modelConnectionSummarySchema.parse(value)
  )
}

export async function refreshModelConnection(connectionId: string) {
  const response = await fetch(
    `/api/agent/connections/${encodeURIComponent(connectionId)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "refresh" }),
    }
  )
  return readResponse(response, (value) =>
    modelConnectionSummarySchema.parse(value)
  )
}

export async function deleteModelConnection(connectionId: string) {
  const response = await fetch(
    `/api/agent/connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" }
  )
  await readResponse(response, () => undefined)
}

export type { ModelConnectionSummary }
