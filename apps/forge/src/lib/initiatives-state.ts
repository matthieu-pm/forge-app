import { useCallback, useMemo, useState, useSyncExternalStore } from "react"
import {
  CANONICAL_ISSUES_CHANGED,
  canonicalIssueState,
  canonicalIssuesActive,
  canonicalProjects,
} from "./canonical-issue-cache"
import {
  projectChangesSchema,
  projectCommandPrefix,
  sharedProjectChanges,
} from "./shared-project-contract"
import {
  blankInitiative,
  defaultInitiativePreferences,
  defaultInitiativesSettings,
  emptyInitiatives,
  initiativePreferencesKey,
  initiativeStoreSchema,
  initiativesSettingsSchema,
  initiativesSettingsStorageKey,
  initiativesStorageKey,
} from "./initiatives"
import {
  initialInitiativeLabels,
  initialProjectLabels,
  initiativeLabelsStorageKey,
  parseTeamLabels,
  projectLabelsStorageKey,
} from "./team-labels"
import {
  initiativeCommandPrefix,
  sharedInitiativesKey,
} from "./shared-initiative-key"
import {
  initiativeChangesSchema,
  sharedInitiativeChanges,
} from "./shared-initiative-contract"
import { protectedSessionEpoch } from "./protected-session"
import type { InitiativeStore } from "./initiatives"
import { productStorage, productStorageIdentity } from "@/lib/product-storage"
import { useWorkspaceView } from "@/components/account-preference-provider"

const changed = "forge:initiatives-changed"
function subscribe(notify: () => void) {
  for (const type of ["storage", "focus", changed, CANONICAL_ISSUES_CHANGED])
    window.addEventListener(type, notify)
  return () => {
    for (const type of ["storage", "focus", changed, CANONICAL_ISSUES_CHANGED])
      window.removeEventListener(type, notify)
  }
}
export function useInitiatives(
  workspaceId: string,
  userId: string,
  scope: "initiatives" | "projects" = "initiatives"
) {
  const renderSession = productStorageIdentity()?.sessionId
  const renderEpoch = protectedSessionEpoch()
  const [mutationError, setMutationError] = useState("")
  const sync = useWorkspaceView("initiatives", "main", { workspaceId, userId })
  const dataKey = canonicalIssuesActive()
    ? sharedInitiativesKey(workspaceId)
    : initiativesStorageKey(workspaceId)
  const preferencesKey = initiativePreferencesKey(workspaceId, userId)
  const settingsKey = initiativesSettingsStorageKey(workspaceId)
  const raw = useSyncExternalStore(
    subscribe,
    useCallback(() => {
      try {
        return JSON.stringify(
          [
            dataKey,
            preferencesKey,
            settingsKey,
            initiativeLabelsStorageKey,
            projectLabelsStorageKey,
          ]
            .map((key) => productStorage.getItem(key))
            .concat(
              JSON.stringify(canonicalIssuesActive()),
              JSON.stringify(canonicalProjects(workspaceId)),
              JSON.stringify(
                Array.from({ length: productStorage.length }, (_, i) =>
                  productStorage.key(i)
                )
                  .filter(
                    (key) =>
                      key?.startsWith(projectCommandPrefix) ||
                      key?.startsWith(initiativeCommandPrefix)
                  )
                  .map((key) => productStorage.getItem(key))
              )
            )
        )
      } catch {
        return "unavailable"
      }
    }, [dataKey, preferencesKey, settingsKey]),
    () => ""
  )
  const data = useMemo(() => {
    const result = {
      ready: Boolean(raw),
      state: emptyInitiatives(),
      preferences: defaultInitiativePreferences(),
      settings: defaultInitiativesSettings as ReturnType<
        typeof initiativesSettingsSchema.parse
      >,
      labels: initialInitiativeLabels().labels,
      projectLabels: initialProjectLabels().labels,
      error: "",
      preferencesError: "",
      settingsError: "",
      labelsError: "",
      projectLabelsError: "",
    }
    if (!raw) return result
    if (raw === "unavailable") {
      result.error =
        "Initiatives could not be loaded. Saved data has been preserved."
      return result
    }
    const values = JSON.parse(raw) as Array<string | null>
    try {
      if (values[0])
        result.state = initiativeStoreSchema.parse(JSON.parse(values[0]))
    } catch {
      result.error =
        "Saved initiatives could not be loaded. Your data has been preserved."
    }
    try {
      if (values[2])
        result.settings = initiativesSettingsSchema.parse(JSON.parse(values[2]))
    } catch {
      result.settingsError =
        "Initiative settings could not be loaded. Saved settings have been preserved."
    }
    try {
      if (values[3])
        result.labels = parseTeamLabels(values[3]).labels.filter(
          (label) => !label.archived
        )
    } catch {
      result.labelsError =
        "Initiative labels could not be loaded. Saved labels have been preserved."
    }
    try {
      if (values[4])
        result.projectLabels = parseTeamLabels(values[4]).labels.filter(
          (label) => !label.archived
        )
    } catch {
      result.projectLabelsError =
        "Project labels could not be loaded. Saved labels have been preserved."
    }
    if (canonicalIssuesActive()) {
      for (let i = 0; i < productStorage.length; i++) {
        const key = productStorage.key(i)
        if (!key?.startsWith(initiativeCommandPrefix)) continue
        try {
          for (const c of initiativeChangesSchema.parse(
            JSON.parse(productStorage.getItem(key)!)
          )) {
            const old = result.state.initiatives.find(
              (item) => item.id === c.id
            )
            if (!old) {
              if (c.expectedRevision === null)
                result.state.initiatives.push(
                  initiativeStoreSchema.shape.initiatives.element.parse({
                    ...blankInitiative(userId),
                    ...c.changes,
                    id: c.id,
                    number: result.state.nextNumber++,
                    projects: canonicalProjects(workspaceId).filter((p) =>
                      c.addProjectIds.includes(p.id)
                    ),
                  })
                )
              continue
            }
            result.state.initiatives = result.state.initiatives.map((item) =>
              item.id === c.id
                ? {
                    ...item,
                    ...c.changes,
                    projects: [
                      ...item.projects.filter(
                        (p) => !c.removeProjectIds.includes(p.id)
                      ),
                      ...canonicalProjects(workspaceId).filter(
                        (p) =>
                          c.addProjectIds.includes(p.id) &&
                          !item.projects.some((o) => o.id === p.id)
                      ),
                    ],
                  }
                : item
            )
          }
        } catch {
          /* Invalid or revoked drafts remain in recovery. */
        }
      }
    }
    const shared = canonicalProjects(workspaceId)
    if (canonicalIssuesActive()) {
      if (scope === "projects") result.error = ""
      // Pending commands are private projections; only acknowledgement promotes
      // them to shared state. Revoked/deleted canonical rows never fall back to
      // an old personal initiative copy.
      const projected = new Map(shared.map((p) => [p.id, p]))
      for (let i = 0; i < productStorage.length; i++) {
        const key = productStorage.key(i)
        if (!key?.startsWith(projectCommandPrefix)) continue
        try {
          for (const change of projectChangesSchema.parse(
            JSON.parse(productStorage.getItem(key)!)
          )) {
            const previous = projected.get(change.id)
            if (!previous && change.expectedRevision !== null) continue
            projected.set(change.id, {
              status: "Backlog",
              health: "Update missing",
              name: "",
              teamIds: [],
              ...previous,
              ...change.changes,
              id: change.id,
            })
          }
        } catch {
          /* The save banner retains invalid commands for review. */
        }
      }
      shared.splice(0, shared.length, ...projected.values())
      result.state = {
        ...result.state,
        workspaceProjects: shared,
        // The initiative read is an independent authorized snapshot. Replacing
        // children from the project cache could restore a revoked team's data
        // or older project status at the same revision.
      }
    } else if (shared.length) {
      const byId = new Map(shared.map((p) => [p.id, p]))
      result.state = {
        ...result.state,
        workspaceProjects: [
          ...result.state.workspaceProjects.filter((p) => !byId.has(p.id)),
          ...shared,
        ],
        initiatives: result.state.initiatives.map((i) => ({
          ...i,
          projects: i.projects.map((p) => byId.get(p.id) ?? p),
        })),
      }
    }
    return result
  }, [raw, workspaceId, userId, scope])
  function update(reducer: (current: InitiativeStore) => InitiativeStore) {
    if (
      !data.ready ||
      data.error ||
      (scope === "initiatives" &&
        (data.settingsError || !data.settings.enabled))
    )
      return false
    try {
      setMutationError("")
      const binding = productStorageIdentity()
      if (
        renderEpoch !== protectedSessionEpoch() ||
        (renderSession && binding?.sessionId !== renderSession)
      )
        throw new Error(
          "The active session changed. Reopen this project before saving."
        )
      if (
        binding &&
        (binding.workspaceId !== workspaceId || binding.userId !== userId)
      )
        throw new Error(
          "The active workspace changed. Reopen this project before saving."
        )
      if (canonicalIssuesActive()) {
        const current = canonicalIssueState()
        if (
          !current ||
          current.workspaceId !== workspaceId ||
          current.userId !== userId ||
          (binding && current.sessionId !== binding.sessionId)
        )
          throw new Error(
            "The active session changed. Reopen this project before saving."
          )
        const next = initiativeStoreSchema.parse(reducer(data.state))
        const initiativeChanges = sharedInitiativeChanges(data.state, next)
        if (
          initiativeChanges.length &&
          (!data.settings.enabled || data.settingsError)
        )
          throw new Error(
            "Shared initiatives are not enabled for this workspace."
          )
        if (initiativeChanges.length) {
          for (let i = 0; i < productStorage.length; i++) {
            const key = productStorage.key(i)
            if (
              key?.startsWith(initiativeCommandPrefix) &&
              initiativeChangesSchema
                .parse(JSON.parse(productStorage.getItem(key)!))
                .some((p) => initiativeChanges.some((c) => c.id === p.id))
            )
              throw new Error(
                "Wait for this initiative's pending save before editing it again. Your draft is preserved in the save banner."
              )
          }
        }
        const changes = sharedProjectChanges(data.state, next)
        if (changes.length) {
          for (let i = 0; i < productStorage.length; i++) {
            const key = productStorage.key(i)
            if (
              key?.startsWith(projectCommandPrefix) &&
              projectChangesSchema
                .parse(JSON.parse(productStorage.getItem(key)!))
                .some((pending) =>
                  changes.some((change) => change.id === pending.id)
                )
            )
              throw new Error(
                "Wait for this project's pending save before editing it again. Your draft is preserved in the save banner."
              )
          }
          // One immutable batch identity; the existing queue journals every
          // draft, replays uncertain outcomes and exposes conflict recovery.
          productStorage.setItem(
            `${projectCommandPrefix}${crypto.randomUUID()}`,
            JSON.stringify(changes)
          )
        }
        if (initiativeChanges.length)
          productStorage.setItem(
            `${initiativeCommandPrefix}${crypto.randomUUID()}`,
            JSON.stringify(initiativeChanges)
          )
        window.dispatchEvent(new Event(changed))
        return true
      }
      const stored = productStorage.getItem(dataKey)
      const next = initiativeStoreSchema.parse(
        reducer(
          stored
            ? initiativeStoreSchema.parse(JSON.parse(stored))
            : emptyInitiatives()
        )
      )
      productStorage.setItem(dataKey, JSON.stringify(next))
      window.dispatchEvent(new Event(changed))
      return true
    } catch (failure) {
      if (canonicalIssuesActive())
        setMutationError(
          failure instanceof Error
            ? failure.message
            : "Project changes could not be saved."
        )
      return false
    }
  }
  return {
    canonical: canonicalIssuesActive(),
    canModerate: ["owner", "admin"].includes(
      productStorageIdentity()?.workspaceRole ?? ""
    ),
    ...data,
    mutationError,
    update,
    preferences: sync.value,
    preferencesError: sync.error,
    savePreferences: sync.save,
    writable:
      data.ready &&
      !data.error &&
      (scope === "projects" || (!data.settingsError && data.settings.enabled)),
  }
}
export type InitiativeData = ReturnType<typeof useInitiatives>
