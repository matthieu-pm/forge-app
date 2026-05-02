import { useSyncExternalStore } from "react"
import { SAMPLE_INITIATIVES, type Initiative } from "@/lib/initiatives-data"

let initiatives: Initiative[] = SAMPLE_INITIATIVES
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot() {
  return initiatives
}

export function useInitiatives() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useInitiative(id: string | undefined): Initiative | null {
  const all = useInitiatives()
  if (!id) return null
  return all.find((i) => i.id === id) ?? null
}

export function addInitiative(init: Initiative) {
  initiatives = [...initiatives, init]
  notify()
}

export function updateInitiative(id: string, patch: Partial<Initiative>) {
  initiatives = initiatives.map((i) => (i.id === id ? { ...i, ...patch } : i))
  notify()
}
