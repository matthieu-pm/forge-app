import "@tanstack/react-start/server-only"
import { and, eq } from "drizzle-orm"
import type { Actor } from "@/application/actor"
import type { DatabaseExecutor } from "@/db"
import { productState } from "@/db"
import {
  defaultInitiativesSettings,
  initiativesSettingsSchema,
  initiativesSettingsStorageKey,
} from "@/lib/initiatives"

export async function initiativeSettings(tx: DatabaseExecutor, actor: Actor) {
  const [row] = await tx
    .select()
    .from(productState)
    .where(
      and(
        eq(productState.workspaceId, actor.workspaceId),
        eq(productState.ownerId, "workspace"),
        eq(productState.key, initiativesSettingsStorageKey(actor.workspaceId))
      )
    )
  const settings = row?.encodedValue
    ? initiativesSettingsSchema.parse(JSON.parse(JSON.parse(row.encodedValue)))
    : defaultInitiativesSettings
  return {
    ...settings,
    enabled:
      process.env.FORGE_FEATURE_INITIATIVES === "true" && settings.enabled,
  }
}
