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

export const teamIdSchema = z.uuid()
export const teamSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)

export const teamIconSchema = z.discriminatedUnion("kind", [
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

export const createTeamInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    identifier: z
      .string()
      .trim()
      .transform((value) => value.toUpperCase())
      .pipe(z.string().regex(/^[A-Z][A-Z0-9]{0,4}$/)),
    icon: teamIconSchema,
    timezone: z.string().trim().refine(isTimeZone, "Invalid timezone."),
  })
  .strict()

export type CreateTeamInput = z.infer<typeof createTeamInputSchema>

export const deleteTeamInputSchema = z
  .object({
    slug: teamSlugSchema,
    confirmationName: z.string().trim().min(1).max(80),
  })
  .strict()

export type DeleteTeamInput = z.infer<typeof deleteTeamInputSchema>

export const teamLifecycleSchema = z.enum(["active", "archived"])
export type TeamLifecycle = z.infer<typeof teamLifecycleSchema>

export const teamMutationInputSchema = z
  .object({
    slug: teamSlugSchema,
  })
  .strict()

export type TeamMutationInput = z.infer<typeof teamMutationInputSchema>

export const updateTeamSettingsSchema = z
  .object({
    icon: teamIconSchema.optional(),
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
  .strict()
  .refine((settings) => Object.keys(settings).length > 0, {
    message: "Choose at least one setting to update.",
  })

export const updateTeamInputSchema = z
  .object({
    slug: teamSlugSchema,
    settings: updateTeamSettingsSchema,
  })
  .strict()

export type UpdateTeamInput = z.infer<typeof updateTeamInputSchema>

export const teamSummarySchema = z
  .object({
    id: teamIdSchema,
    slug: teamSlugSchema,
    identifier: z.string(),
    name: z.string(),
    icon: teamIconSchema,
    timezone: z.string(),
    description: z.string(),
    visibility: z.enum(["workspace", "private"]),
    estimationScheme: z.enum(ESTIMATION_SCHEMES),
    issueEmailEnabled: z.boolean(),
    detailedHistoryEnabled: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .strict()

export type TeamSummary = z.infer<typeof teamSummarySchema>

export const teamDirectoryMemberSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    username: z.string(),
    image: z.string().nullable(),
  })
  .strict()

export type TeamDirectoryMember = z.infer<typeof teamDirectoryMemberSchema>

export const teamDirectoryEntrySchema = teamSummarySchema.extend({
  lifecycle: teamLifecycleSchema,
  isMember: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  memberPreviews: z.array(teamDirectoryMemberSchema).max(5),
  issueCount: z.number().int().nonnegative().nullable(),
  recoverableUntil: z.iso.datetime().nullable(),
  capabilities: z
    .object({
      canOpenSettings: z.boolean(),
      canLeave: z.boolean(),
      canDelete: z.boolean(),
      canRestore: z.boolean(),
    })
    .strict(),
})

export type TeamDirectoryEntry = z.infer<typeof teamDirectoryEntrySchema>

export const teamDirectorySchema = z
  .object({
    items: z.array(teamDirectoryEntrySchema),
    canCreateTeam: z.boolean(),
  })
  .strict()

export type TeamDirectory = z.infer<typeof teamDirectorySchema>

export type TeamRouteState =
  | { status: "ready"; team: TeamSummary }
  | {
      status: "unauthenticated" | "no-workspace" | "forbidden" | "not-found"
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

export type RestoreTeamResult =
  | { ok: true; team: TeamSummary }
  | {
      ok: false
      code:
        | "UNAUTHENTICATED"
        | "NO_ACTIVE_WORKSPACE"
        | "FORBIDDEN"
        | "TEAM_NOT_FOUND"
        | "RESTORE_CONFLICT"
        | "UNKNOWN"
      message: string
    }

export type LeaveTeamResult =
  | { ok: true; team: Pick<TeamSummary, "name" | "slug"> }
  | {
      ok: false
      code:
        | "UNAUTHENTICATED"
        | "NO_ACTIVE_WORKSPACE"
        | "FORBIDDEN"
        | "TEAM_NOT_FOUND"
        | "NOT_A_MEMBER"
        | "LAST_LEAD"
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
