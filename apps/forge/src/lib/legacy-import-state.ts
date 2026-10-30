import { createServerFn } from "@tanstack/react-start"
import type { PreviewContext } from "./legacy-import-preview"

/** No legacy source bytes are accepted by this read-only endpoint. */
export const loadLegacyPreviewContext = createServerFn({
  method: "GET",
}).handler(async (): Promise<PreviewContext> => {
  const [
    { getRequest, setResponseHeader },
    { requireSessionActor },
    { getTeamDirectoryForRequest },
    definitions,
    { buildAuthState },
  ] = await Promise.all([
    import("@tanstack/react-start/server"),
    import("@/adapters/auth/session-actor.server"),
    import("@/lib/team-server"),
    import("@/application/issue-definitions/definitions.server"),
    import("@/lib/auth-server"),
  ])
  setResponseHeader("Cache-Control", "private, no-store")
  const request = getRequest()
  const actor = await requireSessionActor(request)
  const [state, teams, scopes] = await Promise.all([
    buildAuthState(request),
    getTeamDirectoryForRequest(request, "active"),
    definitions.readAllIssueDefinitions(actor),
  ])
  if (
    !state.workspace ||
    !state.user ||
    !state.session ||
    state.workspace.id !== scopes.workspaceId ||
    state.user.id !== scopes.userId ||
    state.session.id !== scopes.sessionId
  )
    throw new Error("The active account changed. Reload and try again.")
  return {
    actorId: scopes.userId,
    accountLabel: state.user.name
      ? `${state.user.name} (${state.user.email})`
      : state.user.email,
    sessionId: scopes.sessionId,
    workspace: { id: state.workspace.id, name: state.workspace.name },
    teams: teams.items
      .filter((team) => team.isMember)
      .map(({ id, name, visibility }) => ({ id, name, visibility })),
    definitions: scopes.snapshots.sort((a, b) =>
      (a.teamId ?? "").localeCompare(b.teamId ?? "")
    ),
  }
})
