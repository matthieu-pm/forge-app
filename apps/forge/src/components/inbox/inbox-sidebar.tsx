import { useEffect, useId, useRef, useState } from "react"
import type { CSSProperties, PointerEvent, ReactNode } from "react"
import type { InboxScope } from "@/lib/inbox-state"
import { cn } from "@/lib/utils"

const MIN_SCALE = 0.8
const MAX_SCALE = 2
const clamp = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

export function InboxSidebar({
  children,
  scope,
  selected,
}: {
  children: ReactNode
  scope: InboxScope
  selected: boolean
}) {
  const id = useId()
  const sidebar = useRef<HTMLElement>(null)
  const drag = useRef<{
    pointerId: number
    startX: number
    startScale: number
    baseWidth: number
    scale: number
  } | null>(null)
  const [scale, setScale] = useState(1)
  const [resizing, setResizing] = useState(false)
  const storageKey = `forge:inbox-sidebar-width:v1:${JSON.stringify([scope.workspaceId, scope.userId])}`

  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey) ?? 1)
      setScale(Number.isFinite(saved) ? clamp(saved) : 1)
    } catch {
      setScale(1)
    }
  }, [storageKey])

  useEffect(() => {
    if (!resizing) return
    const { style } = document.documentElement
    const { cursor, userSelect } = style
    style.cursor = "col-resize"
    style.userSelect = "none"
    return () => {
      style.cursor = cursor
      style.userSelect = userSelect
    }
  }, [resizing])

  function save(next: number) {
    const bounded = clamp(next)
    setScale(bounded)
    try {
      localStorage.setItem(storageKey, String(bounded))
    } catch {
      // Resizing remains available when local preferences cannot be stored.
    }
  }

  function finish(event: PointerEvent<HTMLDivElement>, canceled = false) {
    if (drag.current?.pointerId !== event.pointerId) return
    const current = drag.current
    drag.current = null
    setResizing(false)
    if (canceled) setScale(current.startScale)
    else save(current.scale)
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <section
      ref={sidebar}
      id={id}
      aria-label="Notifications"
      style={{ "--inbox-sidebar-scale": scale } as CSSProperties}
      className={cn(
        "relative flex min-h-0 w-full shrink-0 flex-col border-border/50 md:w-[calc(min(360px,42%)*var(--inbox-sidebar-scale))] md:border-r xl:w-[calc(min(400px,42%)*var(--inbox-sidebar-scale))]",
        selected && "hidden md:flex"
      )}
    >
      {children}
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize inbox sidebar"
        aria-orientation="vertical"
        aria-controls={id}
        aria-valuemin={MIN_SCALE * 100}
        aria-valuemax={MAX_SCALE * 100}
        aria-valuenow={Math.round(scale * 100)}
        aria-valuetext={`${Math.round(scale * 100)}% of default width`}
        title="Drag to resize. Double-click to reset."
        data-resizing={resizing}
        className="absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:resize-handle-gradient after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:opacity-100 data-[resizing=true]:after:opacity-100 md:block"
        onPointerDown={(event) => {
          if (event.button !== 0 || event.isPrimary === false || drag.current)
            return
          const width = sidebar.current?.getBoundingClientRect().width ?? 0
          if (!width) return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          drag.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startScale: scale,
            baseWidth: width / scale,
            scale,
          }
          setResizing(true)
        }}
        onPointerMove={(event) => {
          const current = drag.current
          if (!current || current.pointerId !== event.pointerId) return
          current.scale = clamp(
            current.startScale +
              (event.clientX - current.startX) / current.baseWidth
          )
          setScale(current.scale)
        }}
        onPointerUp={(event) => finish(event)}
        onPointerCancel={(event) => finish(event, true)}
        onLostPointerCapture={(event) => finish(event)}
        onDoubleClick={() => save(1)}
        onKeyDown={(event) => {
          event.stopPropagation()
          const next =
            event.key === "ArrowLeft"
              ? scale - 0.05
              : event.key === "ArrowRight"
                ? scale + 0.05
                : event.key === "Home"
                  ? MIN_SCALE
                  : event.key === "End"
                    ? MAX_SCALE
                    : undefined
          if (next === undefined) return
          event.preventDefault()
          save(next)
        }}
      />
    </section>
  )
}
