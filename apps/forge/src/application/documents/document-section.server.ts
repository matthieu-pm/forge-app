import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import type { Transaction } from "@/db"
import { teamResourceBoards } from "@/db"

/** Caller holds the workspace serialization fence and current source access. */
export async function requireDocumentSection(
  tx: Transaction,
  workspaceId: string,
  teamId: string,
  sectionId: string
) {
  const [board] = await tx
    .select({ fields: teamResourceBoards.fields })
    .from(teamResourceBoards)
    .where(
      and(
        eq(teamResourceBoards.workspaceId, workspaceId),
        eq(teamResourceBoards.teamId, teamId)
      )
    )
    .for("share")
  if (!board?.fields.sections.some((section) => section.id === sectionId))
    throw new Error(
      "This resource section is no longer available. Choose a current section or Team resources."
    )
}
