import { z } from "zod"
import { canonicalCommandInput, withoutUndefined } from "./canonical-json"
import { issueDraftSchema } from "./issue-record-contract"
import { initiativeProjectSchema } from "./initiatives"
import type { InitiativeProject } from "./initiatives"
import type { IssueDraft } from "./issue-record-contract"

export const createCanonicalIssueSchema = z
  .object({
    teamId: z.uuid(),
    commandKey: z.string().min(1).max(255),
    draft: issueDraftSchema.extend({
      cycle: z.union([z.uuid(), z.iso.date(), z.literal("")]).default(""),
      title: z.string().trim().min(1).max(240),
      subIssues: issueDraftSchema.shape.subIssues
        .removeDefault()
        .max(100)
        .default([]),
      links: issueDraftSchema.shape.links.removeDefault().max(100).default([]),
    }),
    // Missing means eligible personal automation; null explicitly means unassigned.
    assigneeId: z.string().min(1).nullable().optional(),
    legacyId: z.string().min(1).max(255).optional(),
    projectImport: initiativeProjectSchema.optional(),
    cycleImport: z
      .object({ startDate: z.iso.date(), endDate: z.iso.date() })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (input) =>
      !(input.draft.attachments ?? []).some((f) => f.fileId || !f.data),
    "Upload durable files after creating the issue."
  )
  .refine(
    (input) =>
      (input.draft.attachments ?? []).reduce(
        (sum, file) => sum + (file.data.split(",")[1]?.length ?? 0) * 0.75,
        0
      ) <= 2_000_000,
    "Choose attachments totaling no more than 2 MB."
  )
export const browserCreateIssueSchema = createCanonicalIssueSchema
  .safeExtend({
    workspaceId: z.string().min(1),
    sessionId: z.string().min(1),
  })
  .strict()
export type CreateCanonicalIssue = z.infer<typeof createCanonicalIssueSchema>

export function legacyIssueSource(
  draft: IssueDraft,
  assigneeId?: string | null
) {
  return withoutUndefined({
    draft: issueDraftSchema.parse({ ...draft, subIssues: [] }),
    assigneeId: assigneeId ?? draft.assignee ?? null,
  })
}
export async function legacyIssueFingerprint(
  draft: IssueDraft,
  assigneeId?: string | null
) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      canonicalCommandInput(legacyIssueSource(draft, assigneeId))
    )
  )
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function legacyProjectSource(project: InitiativeProject) {
  return withoutUndefined(initiativeProjectSchema.parse(project))
}
export async function legacyProjectFingerprint(project: InitiativeProject) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      canonicalCommandInput(legacyProjectSource(project))
    )
  )
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}
