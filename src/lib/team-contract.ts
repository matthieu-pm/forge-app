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

export const ESTIMATION_SCHEMES = [
  "none",
  "exponential",
  "fibonacci",
  "linear",
  "tshirt",
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

export const deleteTeamInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  confirmationName: z.string().trim().min(1).max(80),
})

export type DeleteTeamInput = z.infer<typeof deleteTeamInputSchema>

const updateTeamSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    identifier: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z][A-Z0-9]{0,4}$/))
      .optional(),
    description: z.string().trim().max(500).optional(),
    timezone: z
      .string()
      .trim()
      .refine(isTimeZone, "Invalid timezone.")
      .optional(),
    estimationScheme: z.enum(ESTIMATION_SCHEMES).optional(),
    issueEmailEnabled: z.boolean().optional(),
    detailedHistoryEnabled: z.boolean().optional(),
  })
  .refine((settings) => Object.keys(settings).length > 0, {
    message: "Choose at least one setting to update.",
  })

export const updateTeamInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  settings: updateTeamSettingsSchema,
})

export type UpdateTeamInput = z.infer<typeof updateTeamInputSchema>

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
  description: string
  estimationScheme: (typeof ESTIMATION_SCHEMES)[number]
  issueEmailEnabled: boolean
  detailedHistoryEnabled: boolean
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

export type DeleteTeamResult =
  | {
      ok: true
      team: Pick<TeamSummary, "name" | "slug">
      recoverableUntil: string
    }
  | {
      ok: false
      code:
        | "UNAUTHENTICATED"
        | "NO_ACTIVE_WORKSPACE"
        | "FORBIDDEN"
        | "TEAM_NOT_FOUND_OR_NAME_MISMATCH"
        | "UNKNOWN"
      message: string
    }

export type UpdateTeamResult =
  | { ok: true; team: TeamSummary }
  | {
      ok: false
      code:
        | "UNAUTHENTICATED"
        | "NO_ACTIVE_WORKSPACE"
        | "FORBIDDEN"
        | "IDENTIFIER_TAKEN"
        | "TEAM_NOT_FOUND"
        | "UNKNOWN"
      message: string
      field?: "identifier"
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
