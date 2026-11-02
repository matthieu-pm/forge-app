import { createContext, useContext } from "react"
import type { ReactNode, RefObject } from "react"

type PortalContainer =
  | HTMLElement
  | ShadowRoot
  | RefObject<HTMLElement | ShadowRoot | null>
  | null
  | undefined

const PortalContainerContext = createContext<PortalContainer>(undefined)

/** Keep protected overlays beneath the same hidden boundary as their trigger. */
export function PortalScope({
  container,
  children,
}: {
  container: PortalContainer
  children: ReactNode
}) {
  return (
    <PortalContainerContext.Provider value={container}>
      {children}
    </PortalContainerContext.Provider>
  )
}

export function usePortalContainer() {
  return useContext(PortalContainerContext)
}
