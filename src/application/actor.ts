export const API_SCOPES = [
  "teams:read",
  "teams:write",
  "issues:read",
  "issues:write",
  "projects:read",
  "projects:write",
] as const

export type ApiScope = (typeof API_SCOPES)[number]

export type Actor = {
  userId: string
  workspaceId: string
  workspaceRole: string
  authentication:
    | { kind: "session"; sessionId: string }
    | { kind: "apiKey"; credentialId: string }
  /** null means the first-party session is not credential-scope limited. */
  scopes: ReadonlyArray<ApiScope> | null
}
