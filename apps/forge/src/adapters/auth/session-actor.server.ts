import "@tanstack/react-start/server-only"

import type { Actor } from "@/application/actor"
import { requireActiveWorkspaceMember } from "@/lib/auth-server"

export async function requireSessionActor(request: Request): Promise<Actor> {
  const member = await requireActiveWorkspaceMember(request)

  return {
    userId: member.userId,
    workspaceId: member.workspace.id,
    workspaceRole: member.role,
    authentication: { kind: "session", sessionId: member.sessionId },
    scopes: null,
  }
}
