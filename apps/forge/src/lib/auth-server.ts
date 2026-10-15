import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import type { AuthState, WorkspaceSummary } from "@/lib/auth-types"
import { auth } from "@/lib/auth"
import { db, members, organizations } from "@/db"

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

type WorkspaceMembership = { workspace: WorkspaceSummary; role: string }

async function loadWorkspaceMembership(
  workspaceId: string,
  userId: string
): Promise<WorkspaceMembership | null> {
  // Route guards and API authorization need a summary, not the member directory.
  const records = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      logo: organizations.logo,
      role: members.role,
    })
    .from(organizations)
    .innerJoin(members, eq(members.organizationId, organizations.id))
    .where(and(eq(organizations.id, workspaceId), eq(members.userId, userId)))
    .limit(1)

  const record = records.at(0)
  if (!record) return null
  const { role, ...workspace } = record
  return { workspace, role }
}

async function loadWorkspaceFromRequest(
  request: Request,
  session: SessionRecord
): Promise<WorkspaceMembership | null> {
  const organizationId = session.session.activeOrganizationId
  if (organizationId) {
    const membership = await loadWorkspaceMembership(
      organizationId,
      session.user.id
    )
    if (membership) return membership
  }

  const workspaces = extractOrganizations(
    await auth.api.listOrganizations({ headers: request.headers })
  )
  const fallbackWorkspace = workspaces.at(0)
  if (!fallbackWorkspace) return null

  const membership = await loadWorkspaceMembership(
    fallbackWorkspace.id,
    session.user.id
  )
  if (!membership) return null

  try {
    await auth.api.setActiveOrganization({
      body: { organizationId: fallbackWorkspace.id },
      headers: request.headers,
    })
  } catch {
    // The verified membership remains usable if this request cannot persist it.
  }
  return membership
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

  return (await loadWorkspaceFromRequest(request, session))?.workspace ?? null
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

export async function requireActiveWorkspaceMember(
  request: Request
): Promise<ActiveWorkspaceMember> {
  const session = await getSession(request)

  if (!session) {
    throw new WorkspaceAccessError("UNAUTHENTICATED")
  }

  const membership = await loadWorkspaceFromRequest(request, session)
  if (!membership) {
    throw new WorkspaceAccessError("NO_ACTIVE_WORKSPACE")
  }
  const { workspace, role } = membership
  if (!role) throw new WorkspaceAccessError("FORBIDDEN")

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

  const workspace =
    (await loadWorkspaceFromRequest(request, session))?.workspace ?? null

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
