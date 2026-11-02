import { useSyncExternalStore } from "react"
import { initialProjectStatuses, readProjectStatuses } from "./project-statuses"
import { productStorageIdentity } from "./product-storage"

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback)
  return () => window.removeEventListener("storage", callback)
}
export function useProjectStatusDirectory() {
  const workspaceId = productStorageIdentity()?.workspaceId
  const raw = useSyncExternalStore(
    subscribe,
    () =>
      JSON.stringify(
        workspaceId
          ? readProjectStatuses(workspaceId)
          : initialProjectStatuses()
      ),
    () => JSON.stringify(initialProjectStatuses())
  )
  return (JSON.parse(raw) as ReturnType<typeof initialProjectStatuses>).statuses
}
