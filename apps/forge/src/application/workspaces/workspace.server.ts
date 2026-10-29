import "@tanstack/react-start/server-only"

import { eq } from "drizzle-orm"
import { z } from "zod"

import type { Actor } from "@/application/actor"
import { requireCurrentActor } from "@/application/resource-policy.server"
import { requireTeamRead } from "@/application/authorization"
import { db, organizations } from "@/db"

export const workspaceDescriptionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    actorRole: z.string().min(1),
  })
  .strict()

export async function describeWorkspace(actor: Actor) {
  actor = await requireCurrentActor(actor)
  requireTeamRead(actor)
  const rows = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
    })
    .from(organizations)
    .where(eq(organizations.id, actor.workspaceId))
    .limit(1)
  const workspace = rows.at(0)
  if (!workspace) throw new Error("The workspace was not found.")
  return workspaceDescriptionSchema.parse({
    ...workspace,
    actorRole: actor.workspaceRole,
  })
}
