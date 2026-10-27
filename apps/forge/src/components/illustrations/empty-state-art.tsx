import { emptyStateArt } from "./empty-state-art.generated"
import type { CSSProperties } from "react"
import { cn } from "@/lib/utils"
import "./empty-state-art.css"

export type EmptyStateArtKind = keyof typeof emptyStateArt
const labels: Record<EmptyStateArtKind, string> = {
  projects: "No projects illustration",
  views: "Empty custom views illustration",
  inbox: "Mailbox illustration",
  signals: "Satellite illustration",
  reviews: "Microscope illustration",
  issues: "Issue ticket press illustration",
  initiatives: "Initiative planning table illustration",
  triage: "Triage sorting station illustration",
  cycles: "Upcoming cycle calendar illustration",
  calls: "Conference speakerphone illustration",
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
  const figure = emptyStateArt[kind]
  return (
    <svg
      role="img"
      aria-label={labels[kind]}
      viewBox="0 0 260 208"
      width="196"
      height="157"
      focusable="false"
      className={cn("empty-state-art", className)}
      style={{ "--art-move": figure.move } as CSSProperties}
      // Generated local SVG paths only; no user-authored markup enters this surface.
      dangerouslySetInnerHTML={{ __html: figure.body }}
    />
  )
}
