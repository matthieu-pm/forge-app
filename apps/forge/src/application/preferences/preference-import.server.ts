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
  PreferenceImportCheckpoint,
  PreferenceImportIdentity,
  PreferenceImportManifest,
  PreferenceImportPlan,
  PreferenceImportSource,
} from "@/lib/preference-import-contract"
import {
  accountPreferences,
  db,
  personalPreferenceImportContent,
  personalPreferenceImports,
  productState,
  users,
} from "@/db"
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
  preferenceImportPlanSchema,
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
function manifestQuery(tx: Transaction) {
  return tx
    .select({
      checkpoint: personalPreferenceImports.manifest,
      source: personalPreferenceImportContent.source,
      baseline: personalPreferenceImportContent.baseline,
    })
    .from(personalPreferenceImports)
    .innerJoin(
      personalPreferenceImportContent,
      eq(personalPreferenceImportContent.importId, personalPreferenceImports.id)
    )
}
function hydrateManifest(row: {
  checkpoint: PreferenceImportCheckpoint
  source: PreferenceImportSource
  baseline: Record<string, unknown>
}) {
  return preferenceImportManifestSchema.parse({
    plan: {
      ...row.checkpoint.plan,
      source: row.source,
      snapshot: { ...row.checkpoint.plan.snapshot, values: row.baseline },
    },
    fields: row.checkpoint.fields,
  })
}
function splitManifest(manifest: PreferenceImportManifest) {
  const { source, snapshot, ...plan } = manifest.plan
  const { values: baseline, ...versions } = snapshot
  const checkpoint: PreferenceImportCheckpoint = {
    plan: {
      ...plan,
      source: {
        location: source.location,
        key: source.key,
        ...(source.recovery ? { recoveryKey: source.recovery.key } : {}),
      },
      snapshot: versions,
    },
    fields: manifest.fields,
  }
  return { checkpoint, source, baseline }
}
async function assertSavedSourceCurrent(
  tx: Transaction,
  actor: Actor,
  source: PreferenceImportSource
) {
  if (source.location !== "saved") return
  const row = (
    await tx
      .select({ encodedValue: productState.encodedValue })
      .from(productState)
      .where(
        and(
          eq(productState.workspaceId, actor.workspaceId),
          eq(productState.ownerId, `user:${actor.userId}`),
          eq(productState.ownerUserId, actor.userId),
          eq(productState.key, source.recovery?.key ?? source.key)
        )
      )
      .for("share")
  ).at(0)
  let raw: unknown
  try {
    raw = JSON.parse(row?.encodedValue ?? "null")
  } catch {
    raw = null
  }
  if (raw !== (source.recovery?.raw ?? source.raw))
    throw new Error(
      "The saved source changed. Its preserved copy remains available. Preview again before importing."
    )
}
async function readManifest(
  tx: Transaction,
  actor: Actor,
  id: string,
  lock = false
) {
  const query = manifestQuery(tx).where(
    and(owner(actor), eq(personalPreferenceImports.id, id))
  )
  const row = (await (lock ? query.for("update") : query)).at(0)
  if (!row) throw new ApplicationAccessError()
  const manifest = hydrateManifest(row)
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
    const rows = await manifestQuery(tx)
      .where(owner(actor))
      .orderBy(desc(personalPreferenceImports.createdAt))
    return {
      status: "ready" as const,
      snapshot,
      accountLabel: account
        ? `${account.name} (${account.email})`
        : actor.userId,
      manifests: rows.map(hydrateManifest),
    }
  })
}
export async function preparePreferenceImport(
  actor: Actor,
  raw: PreferenceImportPlan
) {
  const reviewed = preferenceImportPlanSchema.parse(raw)
  const plan = validatePreferenceImportPlan(reviewed)
  authorize(actor, plan.identity)
  if ((await preferenceSourceFingerprint(plan.source)) !== plan.fingerprint)
    throw new Error("The source fingerprint changed. Preview again.")
  const { identity: _identity, ...durable } = reviewed
  await executeCommand({
    actor,
    commandKey: plan.id,
    operation: "personalPreferenceImport.prepare@1",
    input: durable,
    status: 200,
    parse: (value) => z.object({ id: z.uuid() }).strict().parse(value),
    authorize: async (tx, current) => {
      authorize(current, plan.identity)
      await assertSavedSourceCurrent(tx, current, plan.source)
    },
    run: async (tx, current) => {
      const manifest: PreferenceImportManifest = {
        plan,
        fields: Object.fromEntries(
          Object.entries(plan.choices).map(([path, choice]) => [
            path,
            choice === "import" ? "pending" : "kept",
          ])
        ),
      }
      const { checkpoint, source, baseline } = splitManifest(manifest)
      await tx.insert(personalPreferenceImports).values({
        id: plan.id,
        userId: current.userId,
        workspaceId: current.workspaceId,
        manifest: checkpoint,
      })
      await tx
        .insert(personalPreferenceImportContent)
        .values({ importId: plan.id, source, baseline })
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
      await assertSavedSourceCurrent(tx, current, manifest.plan.source)
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
          .set({ manifest: splitManifest(manifest).checkpoint })
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
