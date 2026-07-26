import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import type { AuthState, WorkspaceSummary } from "@/lib/auth-types"
import { auth } from "@/lib/auth"
import { db, members } from "@/db"

type SessionRecord = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>

type OrganizationCandidate = {
  id?: unknown
  name?: unknown
  slug?: unknown
  logo?: unknown
  createdAt?: unknown
}

function toWorkspaceSummary(value: unknown): WorkspaceSummary | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const candidate = value as OrganizationCandidate

  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.slug !== "string"
  ) {
    return null
  }

  return {
    id: candidate.id,
    name: candidate.name,
    slug: candidate.slug,
    logo: typeof candidate.logo === "string" ? candidate.logo : null,
  }
}

function organizationList(value: unknown): Array<unknown> {
  if (Array.isArray(value)) {
    return value
  }

  if (!value || typeof value !== "object") {
    return []
  }

  const record = value as Record<string, unknown>
  if (Array.isArray(record.organizations)) {
    return record.organizations
  }

  return Array.isArray(record.data) ? record.data : []
}

function organizationCreatedAt(value: unknown) {
  if (!value || typeof value !== "object") {
    return Number.MAX_SAFE_INTEGER
  }

  const createdAt = (value as OrganizationCandidate).createdAt
  const timestamp =
    createdAt instanceof Date
      ? createdAt.getTime()
      : typeof createdAt === "string"
        ? Date.parse(createdAt)
        : Number.NaN

  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER
}

function extractOrganizations(value: unknown): Array<WorkspaceSummary> {
  return organizationList(value)
    .map((organization, index) => {
      return {
        workspace: toWorkspaceSummary(organization),
        createdAt: organizationCreatedAt(organization),
        index,
      }
    })
    .filter(
      (
        organization
      ): organization is {
        workspace: WorkspaceSummary
        createdAt: number
        index: number
      } => organization.workspace !== null
    )
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.index - right.index
    )
    .map((organization) => organization.workspace)
}

async function loadWorkspaceFromRequest(
  request: Request,
  session: SessionRecord
): Promise<WorkspaceSummary | null> {
  let organizationId = session.session.activeOrganizationId ?? null

  if (organizationId) {
    try {
      const organization = await auth.api.getFullOrganization({
        query: {
          organizationId,
        },
        headers: request.headers,
      })

      return (
        toWorkspaceSummary(organization) ??
        (organization &&
        typeof organization === "object" &&
        "organization" in organization
          ? toWorkspaceSummary(
              (organization as { organization?: unknown }).organization
            )
          : null)
      )
    } catch {
      organizationId = null
    }
  }

  if (!organizationId) {
    const organizations = extractOrganizations(
      await auth.api.listOrganizations({
        headers: request.headers,
      })
    )

    const fallbackWorkspace = organizations.at(0)
    if (!fallbackWorkspace) {
      return null
    }

    try {
      await auth.api.setActiveOrganization({
        body: {
          organizationId: fallbackWorkspace.id,
        },
        headers: request.headers,
      })
    } catch {
      // If Better Auth cannot persist the active org on this request, we still
      // continue with the discovered workspace so route guards behave correctly
      // for this session.
    }

    return fallbackWorkspace
  }

  return null
}

export async function getSession(request: Request) {
  return auth.api.getSession({
    headers: request.headers,
  })
}

export async function requireSession(request: Request) {
  const session = await getSession(request)

  if (!session) {
    throw new Error("Authenticated session required.")
  }

  return session
}

export async function getActiveWorkspace(request: Request) {
  const session = await getSession(request)

  if (!session) {
    return null
  }

  return loadWorkspaceFromRequest(request, session)
}

export type ActiveWorkspaceMember = {
  userId: string
  sessionId: string
  workspace: WorkspaceSummary
  role: string
}

export class WorkspaceAccessError extends Error {
  constructor(
    readonly code: "UNAUTHENTICATED" | "NO_ACTIVE_WORKSPACE" | "FORBIDDEN"
  ) {
    super(code)
    this.name = "WorkspaceAccessError"
  }
}

async function loadMembershipRole(workspaceId: string, userId: string) {
  const memberRecords = await db
    .select({ role: members.role })
    .from(members)
    .where(
      and(eq(members.organizationId, workspaceId), eq(members.userId, userId))
    )
    .limit(1)

  return memberRecords.at(0)?.role ?? null
}

export async function requireActiveWorkspaceMember(
  request: Request
): Promise<ActiveWorkspaceMember> {
  const session = await getSession(request)

  if (!session) {
    throw new WorkspaceAccessError("UNAUTHENTICATED")
  }

  const activeOrganizationId = session.session.activeOrganizationId ?? null
  const [workspace, activeMembershipRole] = activeOrganizationId
    ? await Promise.all([
        loadWorkspaceFromRequest(request, session),
        loadMembershipRole(activeOrganizationId, session.user.id),
      ])
    : [await loadWorkspaceFromRequest(request, session), null]

  if (!workspace) {
    throw new WorkspaceAccessError("NO_ACTIVE_WORKSPACE")
  }

  const role =
    activeOrganizationId === workspace.id
      ? activeMembershipRole
      : await loadMembershipRole(workspace.id, session.user.id)

  if (!role) {
    throw new WorkspaceAccessError("FORBIDDEN")
  }

  return {
    userId: session.user.id,
    sessionId: session.session.id,
    workspace,
    role,
  }
}

export async function buildAuthState(request: Request): Promise<AuthState> {
  const session = await getSession(request)

  if (!session) {
    return {
      user: null,
      session: null,
      workspace: null,
    }
  }

  const workspace = await loadWorkspaceFromRequest(request, session)

  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image ?? null,
    },
    session: {
      id: session.session.id,
      activeOrganizationId:
        workspace?.id ?? session.session.activeOrganizationId ?? null,
    },
    workspace,
  }
}
