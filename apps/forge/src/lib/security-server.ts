import "@tanstack/react-start/server-only"

import { randomUUID } from "node:crypto"

import type { WorkspaceSecurityCommand } from "@/application/workspace-security/security-contract"
import {
  executeWorkspaceSecurityCommand,
  getWorkspaceSecuritySnapshot,
} from "@/application/workspace-security/workspace-security.server"
import { requireSessionActor } from "@/adapters/auth/session-actor.server"

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin")
  if (!origin) return
  if (origin !== new URL(request.url).origin) {
    throw new Error("Cross-origin security mutations are not allowed.")
  }
}

export async function getWorkspaceSecurityForRequest(request: Request) {
  return getWorkspaceSecuritySnapshot(
    await requireSessionActor(request),
    request.url
  )
}

export async function executeWorkspaceSecurityForRequest(
  request: Request,
  command: WorkspaceSecurityCommand
) {
  assertSameOrigin(request)
  return executeWorkspaceSecurityCommand(
    await requireSessionActor(request),
    command,
    request.url,
    request.headers.get("x-request-id") ?? randomUUID()
  )
}
