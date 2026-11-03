import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  usePreferenceGroup,
  useProtectedIdentity,
} from "./account-preference-provider"
import type { ReactNode } from "react"
import type { PersonIdentity } from "@/lib/person-name"
import {
  formatPersonName,
  formatPersonNames,
  personId,
} from "@/lib/person-name"
import { loadPersonDirectory } from "@/lib/person-directory-state"

const Context = createContext<{
  enabled: boolean
  people: ReadonlyArray<PersonIdentity>
}>({ enabled: false, people: [] })
const emptyPeople: ReadonlyArray<PersonIdentity> = []

export const PersonNameScope = Context.Provider
export const usePersonNamesEnabled = () => useContext(Context).enabled

export function PersonNameProvider({ children }: { children: ReactNode }) {
  const identity = useProtectedIdentity()
  const scope = JSON.stringify(identity)
  const [directory, setDirectory] = useState<{
    scope: string
    enabled: boolean
    people: Array<PersonIdentity>
  }>()
  useEffect(() => {
    if (!identity?.workspaceId) return
    let cancelled = false
    let sequence = 0
    const refresh = () => {
      const request = ++sequence
      void loadPersonDirectory({
        data: {
          workspaceId: identity.workspaceId!,
          sessionId: identity.sessionId,
        },
      }).then(
        (result) => {
          if (!cancelled && request === sequence)
            setDirectory({ scope, ...result })
        },
        () => {
          if (!cancelled && request === sequence) setDirectory(undefined)
        }
      )
    }
    refresh()
    window.addEventListener("focus", refresh)
    window.addEventListener("forge:person-profile-changed", refresh)
    return () => {
      cancelled = true
      window.removeEventListener("focus", refresh)
      window.removeEventListener("forge:person-profile-changed", refresh)
    }
  }, [scope, identity?.workspaceId, identity?.sessionId])
  return (
    <PersonNameScope
      value={
        directory?.scope === scope ? directory : { enabled: false, people: [] }
      }
    >
      {children}
    </PersonNameScope>
  )
}

export function usePersonName(
  people: ReadonlyArray<PersonIdentity> = emptyPeople
) {
  const context = useContext(Context)
  const { preferences } = usePreferenceGroup("general")
  const directory = useMemo(() => {
    const result = new Map(people.map((entry) => [personId(entry), entry]))
    for (const entry of context.people) result.set(personId(entry), entry)
    return result
  }, [context.people, people])
  const labels = useMemo(
    () => formatPersonNames([...directory.values()], preferences.displayNames),
    [directory, preferences.displayNames]
  )
  return useCallback(
    (person?: PersonIdentity | null, fallback = "") => {
      if (!person) return fallback
      if (!context.enabled) return person.name?.trim() || fallback
      const current = directory.get(personId(person)) ?? person
      return (
        labels.get(personId(current)) ??
        formatPersonName(current, preferences.displayNames, [
          ...directory.values(),
        ])
      )
    },
    [context.enabled, preferences.displayNames, directory, labels]
  )
}
