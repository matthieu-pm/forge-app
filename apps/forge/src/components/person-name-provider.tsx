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
import type { NameFormat, PersonIdentity } from "@/lib/person-name"
import {
  formatPersonName,
  formatPersonNames,
  personId,
} from "@/lib/person-name"
import { loadPersonDirectory } from "@/lib/person-directory-state"

type Directory = {
  enabled: boolean
  people: ReadonlyArray<PersonIdentity>
  format: NameFormat
  byId: Map<string, PersonIdentity>
  labels: Map<string, string>
}
const emptyPeople: ReadonlyArray<PersonIdentity> = []
const Context = createContext<Directory>({
  enabled: false,
  people: emptyPeople,
  format: "username",
  byId: new Map(),
  labels: new Map(),
})

function directoryFor(
  people: ReadonlyArray<PersonIdentity>,
  enabled: boolean,
  format: NameFormat
): Directory {
  return {
    enabled,
    format,
    people,
    byId: new Map(people.map((person) => [personId(person), person])),
    labels: enabled ? formatPersonNames(people, format) : new Map(),
  }
}

function withPeers(
  directory: Directory,
  people: ReadonlyArray<PersonIdentity>
) {
  if (
    !directory.enabled ||
    people.every((person) => directory.byId.has(personId(person)))
  )
    return directory
  const merged = new Map(people.map((person) => [personId(person), person]))
  for (const [id, person] of directory.byId) merged.set(id, person)
  return directoryFor([...merged.values()], true, directory.format)
}

export function PersonNameScope({
  value,
  children,
}: {
  value: { enabled: boolean; people: ReadonlyArray<PersonIdentity> }
  children: ReactNode
}) {
  const { preferences } = usePreferenceGroup("general")
  const directory = useMemo(
    () => directoryFor(value.people, value.enabled, preferences.displayNames),
    [value.people, value.enabled, preferences.displayNames]
  )
  return <Context value={directory}>{children}</Context>
}

export function PersonNamePeers({
  people,
  children,
}: {
  people: ReadonlyArray<PersonIdentity>
  children: ReactNode
}) {
  const context = useContext(Context)
  const directory = useMemo(() => withPeers(context, people), [context, people])
  return <Context value={directory}>{children}</Context>
}

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
  const directory = useMemo(() => withPeers(context, people), [context, people])
  return useCallback(
    (person?: PersonIdentity | null, fallback = "") => {
      if (!person) return fallback
      if (!context.enabled) return person.name?.trim() || fallback
      const current = directory.byId.get(personId(person)) ?? person
      return (
        directory.labels.get(personId(current)) ??
        formatPersonName(current, directory.format, directory.people)
      )
    },
    [context.enabled, directory]
  )
}
