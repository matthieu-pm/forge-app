import "@tanstack/react-start/server-only"
import { auth } from "@/lib/auth"
import type { AuthState, WorkspaceSummary } from "@/lib/auth-types"

type SessionRecord = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>

type OrganizationCandidate = {
  id?: unknown
  name?: unknown
  slug?: unknown
  logo?: unknown
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

function extractOrganizations(value: unknown): WorkspaceSummary[] {
  if (Array.isArray(value)) {
    return value
      .map((organization) => toWorkspaceSummary(organization))
      .filter((organization): organization is WorkspaceSummary => organization !== null)
  }

  if (!value || typeof value !== "object") {
    return []
  }

  const record = value as Record<string, unknown>

  if (Array.isArray(record.organizations)) {
    return record.organizations
      .map((organization) => toWorkspaceSummary(organization))
      .filter((organization): organization is WorkspaceSummary => organization !== null)
  }

  if (Array.isArray(record.data)) {
    return record.data
      .map((organization) => toWorkspaceSummary(organization))
      .filter((organization): organization is WorkspaceSummary => organization !== null)
  }

  return []
}

async function loadWorkspaceFromRequest(
  request: Request,
  session: SessionRecord
): Promise<WorkspaceSummary | null> {
  let organizationId = session.session.activeOrganizationId ?? null

  if (!organizationId) {
    const organizations = extractOrganizations(
      await auth.api.listOrganizations({
        headers: request.headers,
      })
    )

    if (organizations.length === 1) {
      organizationId = organizations[0].id

      try {
        await auth.api.setActiveOrganization({
          body: {
            organizationId,
          },
          headers: request.headers,
        })
      } catch {
        // If Better Auth cannot persist the active org on this request, we still
        // continue with the discovered single workspace so route guards behave
        // correctly for this session.
      }
    }
  }

  if (!organizationId) {
    return null
  }

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
    return null
  }
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

export async function buildAuthState(request: Request): Promise<AuthState> {
  const session = await getSession(request)

  if (!session) {
    return {
      user: null,
      session: null,
      workspace: null,
    }
  }

  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name ?? null,
      image: session.user.image ?? null,
    },
    session: {
      id: session.session.id,
      activeOrganizationId: session.session.activeOrganizationId ?? null,
    },
    workspace: await loadWorkspaceFromRequest(request, session),
  }
}
