import "@tanstack/react-start/server-only"

import { randomUUID } from "node:crypto"

import {
  findApprovedDomainWorkspace,
  joinWorkspaceWithApprovedDomain,
  joinWorkspaceWithInvite,
  previewWorkspaceInvite,
} from "@/application/workspace-security/workspace-join.server"
import { auth } from "@/lib/auth"
import { requireSession } from "@/lib/auth-server"

export async function previewWorkspaceInviteForRequest(
  _request: Request,
  token: string
) {
  return previewWorkspaceInvite(token)
}

export async function joinWorkspaceInviteForRequest(
  request: Request,
  token: string
) {
  const origin = request.headers.get("origin")
  if (origin && origin !== new URL(request.url).origin) {
    throw new Error("Cross-origin workspace joins are not allowed.")
  }
  const session = await requireSession(request)
  const result = await joinWorkspaceWithInvite({
    token,
    userId: session.user.id,
    requestId: request.headers.get("x-request-id") ?? randomUUID(),
  })
  await auth.api.setActiveOrganization({
    headers: request.headers,
    body: { organizationId: result.workspaceId },
  })
  return result
}

export async function findApprovedDomainWorkspaceForRequest(request: Request) {
  const session = await requireSession(request)
  return findApprovedDomainWorkspace({
    email: session.user.email,
    emailVerified: session.user.emailVerified,
  })
}

export async function joinApprovedDomainWorkspaceForRequest(
  request: Request,
  workspaceId: string
) {
  const origin = request.headers.get("origin")
  if (origin && origin !== new URL(request.url).origin) {
    throw new Error("Cross-origin workspace joins are not allowed.")
  }
  const session = await requireSession(request)
  const result = await joinWorkspaceWithApprovedDomain({
    email: session.user.email,
    emailVerified: session.user.emailVerified,
    userId: session.user.id,
    workspaceId,
    requestId: request.headers.get("x-request-id") ?? randomUUID(),
  })
  await auth.api.setActiveOrganization({
    headers: request.headers,
    body: { organizationId: result.workspaceId },
  })
  return result
}
