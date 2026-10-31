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
import type { InitiativeStore } from "./initiatives"
import { protectedSessionEpoch } from "./protected-session"
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
  const dataKey = initiativesStorageKey(workspaceId)
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
                  .filter((key) => key?.startsWith(projectCommandPrefix))
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
      const byId = new Map(shared.map((p) => [p.id, p]))
      result.state = {
        ...result.state,
        workspaceProjects: shared,
        initiatives: result.state.initiatives.map((i) => ({
          ...i,
          projects: i.projects.flatMap((p) =>
            byId.has(p.id) ? [byId.get(p.id)!] : []
          ),
        })),
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
  }, [raw, workspaceId, scope])
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
        if (
          scope === "projects" &&
          JSON.stringify(
            next.initiatives.map((i) => [i.id, i.projects.map((p) => p.id)])
          ) !==
            JSON.stringify(
              data.state.initiatives.map((i) => [
                i.id,
                i.projects.map((p) => p.id),
              ])
            )
        )
          throw new Error(
            "Shared initiative links are unavailable until initiative support is enabled."
          )
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
        // Initiative membership and text remain privately saved by their own
        // adapter; canonical project fields are never written there.
        if (scope === "initiatives")
          productStorage.setItem(
            dataKey,
            JSON.stringify({ ...next, workspaceProjects: [] })
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
