import { useMemo, useRef } from "react"
import { useEmptyStateMotion } from "./use-empty-state-motion"
import { emptyStateArt } from "./empty-state-art.generated"
import type { CSSProperties } from "react"
import { cn } from "@/lib/utils"
import "./empty-state-art.css"

export type EmptyStateArtKind = keyof typeof emptyStateArt
const labels: Record<EmptyStateArtKind, string> = {
  milestones: "Milestone checkpoint station illustration",
  projects: "No projects illustration",
  views: "Empty custom views illustration",
  inbox: "Mailbox illustration",
  signals: "Satellite illustration",
  reviews: "Microscope illustration",
  issues: "Issue binder illustration",
  initiatives: "Initiative planning table illustration",
  triage: "Triage sorting station illustration",
  cycles: "Upcoming cycle calendar illustration",
  calls: "Smartphone illustration",
  documents: "Document binding press illustration",
  emojis: "Emoji stamp tray illustration",
  labels: "Label printing station illustration",
}

/** Static, trusted build output from the Anatomy geometry kit. */
export function EmptyStateArt({
  kind,
  className,
}: {
  kind: EmptyStateArtKind
  className?: string
}) {
  const ref = useRef<SVGSVGElement>(null)
  const figure = emptyStateArt[kind]
  // Keep React from replacing an imperatively animated subtree on parent renders.
  const markup = useMemo(() => ({ __html: figure.body }), [figure.body])
  useEmptyStateMotion(ref, kind, figure.body)
  const [motionX, motionY] = figure.move.split(" ")
  return (
    <svg
      ref={ref}
      data-kind={kind}
      role="img"
      aria-label={labels[kind]}
      viewBox="0 0 260 208"
      width="196"
      height="157"
      focusable="false"
      className={cn("empty-state-art", className)}
      style={
        {
          "--art-move": figure.move,
          "--art-x": motionX,
          "--art-y": motionY,
        } as CSSProperties
      }
      // Generated local SVG paths only; no user-authored markup enters this surface.
      dangerouslySetInnerHTML={markup}
    />
  )
}
