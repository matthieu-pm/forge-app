import { createServerFn } from "@tanstack/react-start"
import {
  browserChangeRelationshipSchema,
  browserRelationshipQuerySchema,
  browserRelationshipSearchSchema,
} from "./issue-relationship-contract"

async function relationshipActor(identity: {
  workspaceId: string
  sessionId: string
}) {
  const [{ getRequest, setResponseHeader }, { requireSessionActor }] =
    await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
    ])
  setResponseHeader("Cache-Control", "private, no-store")
  const actor = await requireSessionActor(getRequest())
  if (
    actor.workspaceId !== identity.workspaceId ||
    actor.authentication.kind !== "session" ||
    actor.authentication.sessionId !== identity.sessionId
  )
    throw new Error(
      "The active session changed. Reload before editing relationships."
    )
  return actor
}

export const loadIssueRelationships = createServerFn({ method: "GET" })
  .validator(browserRelationshipQuerySchema)
  .handler(async ({ data }) => {
    const actor = await relationshipActor(data)
    const { readIssueRelationships } =
      await import("@/application/issues/issue-relationships.server")
    const { workspaceId: _w, sessionId: _s, ...input } = data
    return JSON.stringify(await readIssueRelationships(actor, input))
  })

export const persistIssueRelationship = createServerFn({ method: "POST" })
  .validator(browserChangeRelationshipSchema)
  .handler(async ({ data }) => {
    const actor = await relationshipActor(data)
    const { changeIssueRelationship } =
      await import("@/application/issues/issue-relationships.server")
    const { workspaceId: _w, sessionId: _s, ...input } = data
    return JSON.stringify(await changeIssueRelationship(actor, input))
  })

export const searchIssueRelationships = createServerFn({ method: "GET" })
  .validator(browserRelationshipSearchSchema)
  .handler(async ({ data }) => {
    const actor = await relationshipActor(data)
    const { searchRelationshipIssues } =
      await import("@/application/issues/issue-relationships.server")
    const { workspaceId: _w, sessionId: _s, ...input } = data
    return JSON.stringify(await searchRelationshipIssues(actor, input))
  })
