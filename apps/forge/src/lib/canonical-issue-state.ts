import { z } from "zod"
import { createServerFn } from "@tanstack/react-start"
import { browserIssueQuerySchema } from "./issue-query-contract"
import { browserEditIssueSchema } from "./canonical-issue-edit-contract"
import { initiativeProjectSchema } from "./initiatives"
import { browserCreateIssueSchema } from "./canonical-issue-contract"

export const loadCanonicalIssues = createServerFn({ method: "GET" }).handler(
  async () => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/issues/issues.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    return JSON.stringify(
      await service.readCanonicalIssues(
        await requireSessionActor(getRequest()),
        true
      )
    )
  }
)
export const persistCanonicalIssue = createServerFn({ method: "POST" })
  .validator(browserCreateIssueSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/issues/issues.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error(
        "The active session changed. Reload before creating this issue."
      )
    const { workspaceId: _workspaceId, sessionId: _sessionId, ...input } = data
    return JSON.stringify(await service.createCanonicalIssue(actor, input))
  })

export const importCanonicalProjectState = createServerFn({ method: "POST" })
  .validator(
    z
      .object({
        workspaceId: z.string().min(1),
        sessionId: z.string().min(1),
        commandKey: z.string().min(1).max(255),
        project: initiativeProjectSchema,
      })
      .strict()
  )
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/issues/issues.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error("The active session changed.")
    return service.importCanonicalProject(actor, {
      commandKey: data.commandKey,
      project: data.project,
    })
  })

export const persistCanonicalIssueEdits = createServerFn({ method: "POST" })
  .validator(browserEditIssueSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      service,
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/issues/edit-issues.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error("The active session changed.")
    const { workspaceId: _workspaceId, sessionId: _sessionId, ...input } = data
    return JSON.stringify(await service.editCanonicalIssues(actor, input))
  })

export const loadIssueQuery = createServerFn({ method: "GET" })
  .validator(browserIssueQuerySchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      { queryCanonicalIssues },
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/issues/query-issues.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error("The active session changed. Reload the issue list.")
    return JSON.stringify(await queryCanonicalIssues(actor, data.query))
  })

export const loadIssueDetail = createServerFn({ method: "GET" })
  .validator(
    z
      .object({
        workspaceId: z.string().min(1),
        sessionId: z.string().min(1),
        id: z.uuid(),
      })
      .strict()
  )
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      { db },
      { currentCommandActor },
      { readIssueRows },
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/db"),
      import("@/application/commands/command-actor.server"),
      import("@/application/issues/issues.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error("The active session changed.")
    return JSON.stringify(
      await db.transaction(async (tx) =>
        readIssueRows(tx, await currentCommandActor(tx, actor), [data.id])
      )
    )
  })
