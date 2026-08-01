"use client"

import * as React from "react"
import {
  Add01Icon,
  Cancel01Icon,
  Delete02Icon,
  FilePasteIcon,
  Maximize01Icon,
  Minimize01Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import type { AgentEvent } from "@/application/agents/event-contract"
import { AgentComposer } from "@/components/agent/agent-composer"
import { useAgent } from "@/components/agent/agent-provider"
import { AgentTranscript } from "@/components/agent/agent-transcript"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { cn } from "@/lib/utils"

function threadMarkdown(title: string, events: ReadonlyArray<AgentEvent>) {
  const messages = events.flatMap((event) => {
    if (
      event.type === "run.created" &&
      typeof event.payload.message === "string"
    ) {
      return [`## You\n\n${event.payload.message}`]
    }
    if (
      event.type === "assistant.message" &&
      typeof event.payload.content === "string"
    ) {
      return [`## Forge\n\n${event.payload.content}`]
    }
    return []
  })

  return [`# ${title}`, ...messages].join("\n\n")
}

export function AgentChatPanel() {
  const {
    activeThreadId,
    archiveThread,
    closeSurface,
    eventsByThread,
    newChat,
    runningThreadIds,
    resolveApproval,
    retryMessage,
    setSurfaceMode,
    surfaceMode,
    threads,
  } = useAgent()
  const panelRef = React.useRef<HTMLDivElement>(null)
  const endRef = React.useRef<HTMLDivElement>(null)
  const restoreFocusRef = React.useRef<HTMLElement | null>(null)
  const [narrow, setNarrow] = React.useState(false)
  const activeThread = threads.find((thread) => thread.id === activeThreadId)
  const events = activeThreadId ? (eventsByThread[activeThreadId] ?? []) : []
  const running = activeThreadId ? runningThreadIds.has(activeThreadId) : false
  const copyThreadAsMarkdown = React.useCallback(() => {
    if (!activeThread) return
    void navigator.clipboard.writeText(
      threadMarkdown(activeThread.title, events)
    )
  }, [activeThread, events])

  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)")
    const update = () => setNarrow(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  React.useEffect(() => {
    if (surfaceMode === "closed") return
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    window.requestAnimationFrame(() => {
      const composer =
        surfaceMode === "maximized"
          ? panelRef.current?.querySelector<HTMLTextAreaElement>(
              'textarea[aria-label="Message Forge"]'
            )
          : null
      const focusTarget = composer ?? panelRef.current
      focusTarget?.focus()
    })
    return () => restoreFocusRef.current?.focus()
  }, [surfaceMode])

  React.useEffect(() => {
    if (surfaceMode !== "closed") {
      endRef.current?.scrollIntoView({ block: "end" })
    }
  }, [events.length, surfaceMode])

  React.useEffect(() => {
    if (narrow || surfaceMode === "closed") return

    const handleOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (panelRef.current?.contains(event.target)) return
      if (
        event.target instanceof Element &&
        event.target.closest("[data-agent-surface-portal]")
      ) {
        return
      }
      if (surfaceMode === "maximized") {
        setSurfaceMode("floating")
      } else {
        closeSurface()
      }
    }

    document.addEventListener("pointerdown", handleOutsidePointer)
    return () =>
      document.removeEventListener("pointerdown", handleOutsidePointer)
  }, [closeSurface, narrow, setSurfaceMode, surfaceMode])

  React.useEffect(() => {
    if (surfaceMode !== "maximized") return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSurfaceMode("floating")
        return
      }
      if (event.key !== "Tab" || !panelRef.current) return
      const focusable = [
        ...panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ),
      ].filter((element) => !element.hasAttribute("aria-hidden"))
      const first = focusable.at(0)
      const last = focusable.at(-1)
      if (!first || !last) {
        event.preventDefault()
        panelRef.current.focus()
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [setSurfaceMode, surfaceMode])

  if (surfaceMode === "closed") return null

  const maximized = surfaceMode === "maximized"

  const panel = (
    <div
      ref={panelRef}
      style={
        narrow
          ? undefined
          : maximized
            ? {
                top: "2%",
                right: "0.25rem",
                bottom: 0,
                left: "0.25rem",
              }
            : {
                top: "max(4rem, calc(100% - 42.5rem))",
                right: "0.75rem",
                bottom: 0,
                left: "max(0.75rem, calc(100% - 27.625rem))",
              }
      }
      tabIndex={-1}
      role={narrow ? undefined : "dialog"}
      aria-modal={narrow ? undefined : maximized}
      aria-label={
        narrow ? undefined : (activeThread?.title ?? "New Forge chat")
      }
      className={cn(
        "pointer-events-auto z-40 flex min-h-0 flex-col overflow-hidden transition-[top,right,bottom,left,border-radius,box-shadow,filter] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] outline-none motion-reduce:transition-none",
        narrow
          ? "h-full w-full border-0 bg-background shadow-none"
          : maximized
            ? "absolute rounded-2xl bg-background shadow-sm drop-shadow-[0_-8px_14px_rgba(0,0,0,0.07)] dark:drop-shadow-[0_-8px_18px_rgba(0,0,0,0.22)]"
            : "absolute rounded-2xl border bg-background shadow-2xl"
      )}
    >
      <header className="flex h-11 shrink-0 items-center gap-1 px-2.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          <p className="min-w-0 truncate px-1 text-sm font-medium">
            {activeThread?.title ?? "New chat"}
          </p>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  aria-label="Chat options"
                />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuItem
                disabled={!activeThread}
                onClick={copyThreadAsMarkdown}
              >
                <HugeiconsIcon icon={FilePasteIcon} strokeWidth={2} />
                Copy to markdown
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!activeThread}
                onClick={() => {
                  if (activeThread) void archiveThread(activeThread.id)
                }}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="New chat"
          onClick={() => newChat(surfaceMode)}
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={maximized ? "Return to floating chat" : "Maximize chat"}
          onClick={() => setSurfaceMode(maximized ? "floating" : "maximized")}
        >
          <HugeiconsIcon
            icon={maximized ? Minimize01Icon : Maximize01Icon}
            strokeWidth={2}
          />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Close chat"
          onClick={closeSurface}
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <AgentTranscript
          events={events}
          running={running}
          onResolveApproval={resolveApproval}
          onRetry={retryMessage}
        />
        <div ref={endRef} />
      </div>

      <div
        className={cn(
          "shrink-0 bg-gradient-to-t from-background via-background to-transparent px-3 pt-3 pb-3",
          maximized && "mx-auto w-full max-w-3xl px-4 pb-5 sm:px-8"
        )}
      >
        <AgentComposer placeholder="Reply…" />
      </div>
    </div>
  )

  if (!narrow) return panel

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) closeSurface()
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        className="w-full p-0 sm:max-w-full"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{activeThread?.title ?? "New Forge chat"}</SheetTitle>
        </SheetHeader>
        {panel}
      </SheetContent>
    </Sheet>
  )
}
