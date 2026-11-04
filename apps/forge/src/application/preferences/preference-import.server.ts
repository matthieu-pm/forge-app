import "@tanstack/react-start/server-only"
import { and, desc, eq } from "drizzle-orm"
import { z } from "zod"
import {
  assertPreferenceSession,
  assertPreferenceSyncEnabled,
  readAccountPreferences,
} from "./preferences.server"
import type { Actor } from "@/application/actor"
import type { Transaction } from "@/db"
import type {
  PreferenceImportIdentity,
  PreferenceImportPlan,
} from "@/lib/preference-import-contract"
import { accountPreferences, db, personalPreferenceImports, users } from "@/db"
import { accountPreferenceFields } from "@/lib/account-preference-contract"
import { currentCommandActor } from "@/application/commands/command-actor.server"
import { executeCommand } from "@/application/commands/execute-command.server"
import { ApplicationAccessError } from "@/application/authorization"
import {
  featureSnapshot,
  requireFeatureWrite,
} from "@/application/features/features.server"
import {
  inspectPreferenceSource,
  preferenceImportManifestSchema,
  preferenceImportRequestSchema,
  preferenceSourceFingerprint,
  validatePreferenceImportPlan,
} from "@/lib/preference-import-contract"

function authorize(actor: Actor, identity: PreferenceImportIdentity) {
  assertPreferenceSession(actor, identity.sessionId)
  if (
    identity.userId !== actor.userId ||
    identity.workspaceId !== actor.workspaceId
  )
    throw new ApplicationAccessError()
  assertPreferenceSyncEnabled()
  requireFeatureWrite(actor, "personalPreferenceImport")
}
const owner = (actor: Actor) =>
  and(
    eq(personalPreferenceImports.userId, actor.userId),
    eq(personalPreferenceImports.workspaceId, actor.workspaceId)
  )
async function readManifest(
  tx: Transaction,
  actor: Actor,
  id: string,
  lock = false
) {
  const query = tx
    .select()
    .from(personalPreferenceImports)
    .where(and(owner(actor), eq(personalPreferenceImports.id, id)))
  const row = (await (lock ? query.for("update") : query)).at(0)
  if (!row) throw new ApplicationAccessError()
  const manifest = preferenceImportManifestSchema.parse(row.manifest)
  if (
    (await preferenceSourceFingerprint(manifest.plan.source)) !==
    manifest.plan.fingerprint
  )
    throw new Error(
      "The saved source fingerprint changed. Download the original source and preview again."
    )
  return manifest
}
export async function loadPreferenceImports(
  actor: Actor,
  identity: PreferenceImportIdentity
) {
  assertPreferenceSession(actor, identity.sessionId)
  if (
    identity.userId !== actor.userId ||
    identity.workspaceId !== actor.workspaceId
  )
    throw new ApplicationAccessError()
  if (
    process.env.FORGE_PERSONAL_PREFERENCE_SYNC_ENABLED !== "true" ||
    featureSnapshot(actor).personalPreferenceImport !== "enabled"
  )
    return { status: "disabled" as const }
  authorize(actor, identity)
  const snapshot = await readAccountPreferences(actor)
  return db.transaction(async (tx) => {
    await currentCommandActor(tx, actor)
    const account = (
      await tx
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, actor.userId))
    ).at(0)
    const rows = await tx
      .select()
      .from(personalPreferenceImports)
      .where(owner(actor))
      .orderBy(desc(personalPreferenceImports.createdAt))
    return {
      status: "ready" as const,
      snapshot,
      accountLabel: account
        ? `${account.name} (${account.email})`
        : actor.userId,
      manifests: rows.map((row) =>
        preferenceImportManifestSchema.parse(row.manifest)
      ),
    }
  })
}
export async function preparePreferenceImport(
  actor: Actor,
  raw: PreferenceImportPlan
) {
  const plan = validatePreferenceImportPlan(raw)
  authorize(actor, plan.identity)
  if ((await preferenceSourceFingerprint(plan.source)) !== plan.fingerprint)
    throw new Error("The source fingerprint changed. Preview again.")
  const { identity: _identity, ...durable } = plan
  await executeCommand({
    actor,
    commandKey: plan.id,
    operation: "personalPreferenceImport.prepare@1",
    input: durable,
    status: 200,
    parse: (value) => z.object({ id: z.uuid() }).strict().parse(value),
    authorize: (_tx, current) => {
      authorize(current, plan.identity)
      return Promise.resolve()
    },
    run: async (tx, current) => {
      await tx.insert(personalPreferenceImports).values({
        id: plan.id,
        userId: current.userId,
        workspaceId: current.workspaceId,
        manifest: {
          plan,
          fields: Object.fromEntries(
            Object.entries(plan.choices).map(([path, choice]) => [
              path,
              choice === "import" ? "pending" : "kept",
            ])
          ),
        },
      })
      return {
        value: { id: plan.id },
        resource: { type: "personalPreferenceImport", id: plan.id },
        events: [],
      }
    },
  })
  return db.transaction(async (tx) => {
    await currentCommandActor(tx, actor)
    return readManifest(tx, actor, plan.id)
  })
}
export async function applyPreferenceImportField(
  actor: Actor,
  input: z.infer<typeof preferenceImportRequestSchema>
) {
  input = preferenceImportRequestSchema.parse(input)
  authorize(actor, input.identity)
  const operation = "personalPreferenceImport.apply@1"
  await executeCommand({
    actor,
    commandKey: `${input.id}:${input.path}`,
    operation,
    input: { id: input.id, path: input.path, fingerprint: input.fingerprint },
    status: 200,
    parse: (value) => z.object({ id: z.uuid() }).strict().parse(value),
    authorize: async (tx, current) => {
      authorize(current, input.identity)
      const manifest = await readManifest(tx, current, input.id)
      if (
        manifest.plan.fingerprint !== input.fingerprint ||
        !Object.hasOwn(manifest.fields, input.path)
      )
        throw new ApplicationAccessError()
    },
    run: async (tx, current) => {
      const manifest = await readManifest(tx, current, input.id, true)
      if (manifest.fields[input.path] === "pending") {
        const { fields } = inspectPreferenceSource(
          manifest.plan.source,
          current.userId
        )
        if (!Object.hasOwn(fields, input.path))
          throw new ApplicationAccessError()
        await tx
          .insert(accountPreferences)
          .values({ userId: current.userId })
          .onConflictDoNothing()
        const row = (
          await tx
            .select()
            .from(accountPreferences)
            .where(eq(accountPreferences.userId, current.userId))
            .for("update")
        )[0]
        if (row.version !== 1)
          throw new Error("Preferences require a newer version of Forge.")
        const expected = manifest.plan.snapshot.fieldVersions[input.path] ?? 0
        const baseline = manifest.plan.snapshot.values
        // Compare both presence and version so legacy unversioned values cannot overwrite a changed target.
        const matches =
          (row.fieldVersions[input.path] ?? 0) === expected &&
          Object.hasOwn(row.values, input.path) ===
            Object.hasOwn(baseline, input.path) &&
          JSON.stringify(row.values[input.path]) ===
            JSON.stringify(baseline[input.path])
        if (!matches) manifest.fields[input.path] = "conflict"
        else {
          const revision = row.revision + 1
          await tx
            .update(accountPreferences)
            .set({
              revision,
              values: {
                ...row.values,
                [input.path]: accountPreferenceFields[input.path].parse(
                  fields[input.path]
                ),
              },
              fieldVersions: { ...row.fieldVersions, [input.path]: revision },
            })
            .where(eq(accountPreferences.userId, current.userId))
          manifest.fields[input.path] = "saved"
        }
        await tx
          .update(personalPreferenceImports)
          .set({ manifest })
          .where(eq(personalPreferenceImports.id, input.id))
      }
      return {
        value: { id: input.id },
        resource: { type: "personalPreferenceImport", id: input.id },
        events: [],
      }
    },
  })
  return db.transaction(async (tx) => {
    await currentCommandActor(tx, actor)
    return readManifest(tx, actor, input.id)
  })
}
