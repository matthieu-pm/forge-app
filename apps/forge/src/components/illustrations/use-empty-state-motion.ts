import { useEffect } from "react"
import { mountEmptyStateMotion } from "./empty-state-motion"
import type { RefObject } from "react"

export function useEmptyStateMotion(
  ref: RefObject<SVGSVGElement | null>,
  kind: string,
  geometry: string
) {
  useEffect(() => {
    if (ref.current) return mountEmptyStateMotion(ref.current, kind)
  }, [ref, kind, geometry])
}
