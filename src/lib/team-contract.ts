import { z } from "zod"

export const TEAM_COLORS = [
  "#94a3b8",
  "#818cf8",
  "#38bdf8",
  "#34d399",
  "#facc15",
  "#fb923c",
  "#fb7185",
  "#f472b6",
] as const

function isTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

const teamIconSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("icon"),
    value: z.string().regex(/^[A-Za-z][A-Za-z0-9]*Icon$/),
    color: z.enum(TEAM_COLORS),
  }),
  z.object({
    kind: z.literal("emoji"),
    value: z.string().trim().min(1).max(32),
    color: z.enum(TEAM_COLORS),
  }),
])

export const createTeamInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  identifier: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z][A-Z0-9]{0,4}$/)),
  icon: teamIconSchema,
  timezone: z.string().trim().refine(isTimeZone, "Invalid timezone."),
})

export type CreateTeamInput = z.infer<typeof createTeamInputSchema>

export type TeamSummary = {
  id: string
  slug: string
  identifier: string
  name: string
  icon: {
    kind: "icon" | "emoji"
    value: string
    color: string
  }
  timezone: string
}

export type CreateTeamErrorCode =
  | "UNAUTHENTICATED"
  | "NO_ACTIVE_WORKSPACE"
  | "FORBIDDEN"
  | "SLUG_TAKEN"
  | "IDENTIFIER_TAKEN"
  | "INVALID_INPUT"
  | "UNKNOWN"

export type CreateTeamResult =
  | { ok: true; team: TeamSummary }
  | {
      ok: false
      code: CreateTeamErrorCode
      message: string
      field?: "name" | "identifier"
    }

export function slugifyTeamName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
}
