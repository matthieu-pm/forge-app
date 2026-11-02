import { createServerFn } from "@tanstack/react-start"
import {
  browserSavedViewMutationSchema,
  savedViewDefinitionSchema,
  savedViewIdentitySchema,
} from "./saved-view-contract"

export const loadSavedViews = createServerFn({ method: "GET" })
  .validator(savedViewIdentitySchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      { readSavedViews },
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/views/saved-views.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error("The active session changed.")
    return JSON.stringify(await readSavedViews(actor))
  })
export const persistSavedView = createServerFn({ method: "POST" })
  .validator(browserSavedViewMutationSchema)
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      { mutateSavedView },
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/views/saved-views.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error("The active session changed.")
    return mutateSavedView(actor, data.commandKey, data.mutation)
  })

export const loadViewProjects = createServerFn({ method: "GET" })
  .validator(
    savedViewIdentitySchema
      .extend({ definition: savedViewDefinitionSchema })
      .strict()
  )
  .handler(async ({ data }) => {
    const [
      { getRequest, setResponseHeader },
      { requireSessionActor },
      { queryViewProjects },
    ] = await Promise.all([
      import("@tanstack/react-start/server"),
      import("@/adapters/auth/session-actor.server"),
      import("@/application/views/saved-views.server"),
    ])
    setResponseHeader("Cache-Control", "private, no-store")
    const actor = await requireSessionActor(getRequest())
    if (
      actor.workspaceId !== data.workspaceId ||
      actor.authentication.kind !== "session" ||
      actor.authentication.sessionId !== data.sessionId
    )
      throw new Error("The active session changed.")
    return JSON.stringify(await queryViewProjects(actor, data.definition))
  })
