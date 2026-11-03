import "@tanstack/react-start/server-only"
import { Buffer } from "node:buffer"
import { eq } from "drizzle-orm"
import { fileTypeFromBuffer } from "file-type"
import { z } from "zod"
import type { Actor } from "@/application/actor"
import type {
  ProfileCommand,
  ProfileSaveResult,
  ProfileSnapshot,
} from "@/lib/profile-contract"
import { MAX_AVATAR_BYTES, profileCommandSchema } from "@/lib/profile-contract"
import { db, users } from "@/db"
import { ApplicationAccessError } from "@/application/authorization"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"

export function profileEditingEnabled() {
  return process.env.FORGE_PROFILE_EDITING_ENABLED === "true"
}
function assertSession(actor: Actor, input?: ProfileCommand) {
  if (
    actor.authentication.kind !== "session" ||
    (input &&
      (actor.authentication.sessionId !== input.sessionId ||
        actor.workspaceId !== input.expectedWorkspaceId))
  )
    throw new ApplicationAccessError()
}
function assertEnabled() {
  if (!profileEditingEnabled())
    throw new Error("Profile editing is unavailable.")
}
function snapshot(row: typeof users.$inferSelect): ProfileSnapshot {
  return {
    userId: row.id,
    revision: row.updatedAt.toISOString(),
    name: row.name,
    title: row.title ?? "",
    username: row.username,
    image: row.image,
  }
}
export async function validateProfileAvatar(image: string) {
  const [, mime, content] =
    /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(image) ?? []
  if (!content) throw new Error("Choose a PNG, JPEG or WebP image.")
  const bytes = Buffer.from(content, "base64")
  if (
    !bytes.length ||
    bytes.length > MAX_AVATAR_BYTES ||
    bytes.toString("base64") !== content
  )
    throw new Error("Choose an image smaller than 2 MB.")
  const type = await fileTypeFromBuffer(bytes)
  if (type?.mime !== mime)
    throw new Error("The image contents do not match its file type.")
}
export async function readProfile(actor: Actor): Promise<ProfileSnapshot> {
  assertEnabled()
  assertSession(actor)
  return db.transaction(async (tx) => {
    await currentCommandActor(tx, actor)
    const row = (
      await tx.select().from(users).where(eq(users.id, actor.userId))
    ).at(0)
    if (!row) throw new ApplicationAccessError()
    return snapshot(row)
  })
}
class ProfileConflict extends Error {}
export async function patchProfile(
  actor: Actor,
  raw: ProfileCommand
): Promise<ProfileSaveResult> {
  assertEnabled()
  const input = profileCommandSchema.parse(raw)
  assertSession(actor, input)
  if (input.patch.image) await validateProfileAvatar(input.patch.image)
  const { commandKey, sessionId: _sessionId, ...commandInput } = input
  try {
    await executeCommand({
      actor,
      commandKey,
      operation: "accountProfile.patch@1",
      input: commandInput,
      status: 200,
      parse: (value) =>
        z
          .object({ userId: z.string(), revision: z.string().datetime() })
          .strict()
          .parse(value),
      authorize: async (_tx, current, result) => {
        assertSession(current, input)
        if (result && result.userId !== current.userId)
          throw new ApplicationAccessError()
      },
      run: async (tx, current) => {
        const row = (
          await tx
            .select()
            .from(users)
            .where(eq(users.id, current.userId))
            .for("update")
        ).at(0)
        if (!row) throw new ApplicationAccessError()
        if (row.updatedAt.toISOString() !== input.expectedRevision)
          throw new ProfileConflict()
        // Existing account timestamp is the whole-profile version. Advance even within one millisecond.
        const updatedAt = new Date(
          Math.max(Date.now(), row.updatedAt.getTime() + 1)
        )
        await tx
          .update(users)
          .set({ ...input.patch, updatedAt })
          .where(eq(users.id, current.userId))
        return {
          value: { userId: current.userId, revision: updatedAt.toISOString() },
          resource: { type: "accountProfile", id: current.userId },
          events: [],
        }
      },
    })
    return { status: "saved", snapshot: await readProfile(actor) }
  } catch (error) {
    if (error instanceof ProfileConflict)
      return { status: "conflict", snapshot: await readProfile(actor) }
    throw error
  }
}
