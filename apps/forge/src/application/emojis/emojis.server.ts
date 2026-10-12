import "@tanstack/react-start/server-only"
import { and, asc, eq, isNull } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { CustomEmojiInput } from "@/lib/custom-emoji-contract"
import {
  ApplicationAccessError,
  hasWorkspaceRole,
} from "@/application/authorization"
import { assertWorkspaceUploadAllowed } from "@/application/workspace-security/workspace-security.server"
import { db, users, workspaceEmojis } from "@/db"
import {
  customEmojiInputSchema,
  customEmojiValue,
} from "@/lib/custom-emoji-contract"

function requireMember(actor: Actor) {
  if (
    actor.authentication.kind !== "session" ||
    !hasWorkspaceRole(actor, ["owner", "admin", "member"])
  ) {
    throw new ApplicationAccessError()
  }
}
export async function listEmojis(actor: Actor) {
  requireMember(actor)
  const rows = await db
    .select({
      id: workspaceEmojis.id,
      name: workspaceEmojis.name,
      image: workspaceEmojis.image,
      createdAt: workspaceEmojis.createdAt,
      createdBy: workspaceEmojis.createdBy,
      sourceName: users.name,
      sourceImage: users.image,
    })
    .from(workspaceEmojis)
    .leftJoin(users, eq(users.id, workspaceEmojis.createdBy))
    .where(
      and(
        eq(workspaceEmojis.workspaceId, actor.workspaceId),
        isNull(workspaceEmojis.deletedAt)
      )
    )
    .orderBy(asc(workspaceEmojis.name))
  return rows.map(({ createdBy, ...row }) => ({
    ...row,
    value: customEmojiValue(row.id),
    createdAt: row.createdAt.toISOString(),
    sourceName: row.sourceName || "Workspace member",
    canRemove:
      createdBy === actor.userId || hasWorkspaceRole(actor, ["owner", "admin"]),
  }))
}
export async function addEmoji(actor: Actor, input: CustomEmojiInput) {
  requireMember(actor)
  const data = customEmojiInputSchema.parse(input)
  await assertWorkspaceUploadAllowed(actor, "image/png")
  const result = await db
    .insert(workspaceEmojis)
    .values({
      workspaceId: actor.workspaceId,
      createdBy: actor.userId,
      ...data,
    })
    .onConflictDoNothing()
    .returning({ id: workspaceEmojis.id })
  if (!result.length) throw new Error("An emoji with this name already exists.")
  return listEmojis(actor)
}
export async function removeEmoji(actor: Actor, id: string) {
  requireMember(actor)
  const result = await db
    .update(workspaceEmojis)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(workspaceEmojis.id, id),
        eq(workspaceEmojis.workspaceId, actor.workspaceId),
        isNull(workspaceEmojis.deletedAt),
        hasWorkspaceRole(actor, ["owner", "admin"])
          ? undefined
          : eq(workspaceEmojis.createdBy, actor.userId)
      )
    )
    .returning({ id: workspaceEmojis.id })
  if (!result.length)
    throw new Error(
      "This emoji could not be removed. It may already be removed, or you may not have permission."
    )
  return listEmojis(actor)
}
