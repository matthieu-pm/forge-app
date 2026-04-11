export type WorkspaceSummary = {
  id: string
  name: string
  slug: string
  logo: string | null
}

export type AuthState = {
  user: {
    id: string
    email: string
    name: string | null
    image: string | null
  } | null
  session: {
    id: string
    activeOrganizationId: string | null
  } | null
  workspace: WorkspaceSummary | null
}
