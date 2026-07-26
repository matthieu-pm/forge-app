"use client"

import {
  Cancel01Icon,
  Cursor02Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { useAgent } from "@/components/agent/agent-provider"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function AgentTabs() {
  const {
    activeThreadId,
    closeThread,
    closeSurface,
    newChat,
    openThread,
    openThreadIds,
    runningThreadIds,
    surfaceMode,
    threads,
    unreadThreadIds,
  } = useAgent()
  const visibleThreads = openThreadIds.flatMap((id) => {
    const thread = threads.find((candidate) => candidate.id === id)
    return thread ? [thread] : []
  })
  const showNewChat = activeThreadId === null && surfaceMode !== "closed"
  const visibleTabs = [
    ...visibleThreads.map((thread) => ({
      id: thread.id,
      kind: "thread" as const,
      title: thread.title,
    })),
    ...(showNewChat
      ? [
          {
            id: "__new__",
            kind: "new" as const,
            title: "New chat",
          },
        ]
      : []),
  ]

  if (visibleTabs.length === 0) return null

  const mode = surfaceMode === "closed" ? "floating" : surfaceMode

  function activateTab(tab: (typeof visibleTabs)[number]) {
    if (tab.kind === "new") {
      newChat(mode)
      return
    }
    void openThread(tab.id, mode)
  }

  return (
    <div
      role="tablist"
      aria-label="Open Forge chats"
      className="flex max-w-[min(64vw,48rem)] min-w-0 items-center justify-end gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        const activeTabId = activeThreadId ?? (showNewChat ? "__new__" : null)
        const currentIndex = visibleTabs.findIndex(
          (tab) => tab.id === activeTabId
        )
        const direction = event.key === "ArrowRight" ? 1 : -1
        const next =
          visibleTabs[
            (currentIndex + direction + visibleTabs.length) % visibleTabs.length
          ]
        event.preventDefault()
        activateTab(next)
      }}
    >
      {visibleTabs.map((tab) => {
        const active =
          tab.kind === "new" ? showNewChat : tab.id === activeThreadId
        return (
          <div
            key={tab.id}
            className={cn(
              "group flex h-6 max-w-52 min-w-28 shrink-0 items-center rounded-lg border border-transparent text-[11px] text-muted-foreground",
              active && surfaceMode !== "closed"
                ? "border-border bg-muted text-foreground"
                : "hover:bg-muted/60"
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2"
              onClick={() => activateTab(tab)}
            >
              {tab.kind === "thread" && runningThreadIds.has(tab.id) ? (
                <Spinner className="size-3 shrink-0" />
              ) : (
                <HugeiconsIcon
                  icon={Cursor02Icon}
                  strokeWidth={2}
                  className="size-3 shrink-0"
                />
              )}
              <span className="truncate">{tab.title}</span>
              {tab.kind === "thread" &&
              unreadThreadIds.has(tab.id) &&
              !active ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                  aria-label="Unread activity"
                />
              ) : null}
            </button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-5 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={`Close ${tab.title}`}
              onClick={() =>
                tab.kind === "new" ? closeSurface() : closeThread(tab.id)
              }
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          </div>
        )
      })}
      {visibleTabs.length > 1 ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="shrink-0"
                aria-label="Open chat tabs"
              />
            }
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-64">
            {visibleTabs.map((tab) => (
              <DropdownMenuItem key={tab.id} onClick={() => activateTab(tab)}>
                {tab.kind === "thread" && runningThreadIds.has(tab.id) ? (
                  <Spinner className="size-3" />
                ) : (
                  <HugeiconsIcon
                    icon={Cursor02Icon}
                    strokeWidth={2}
                    className="size-3"
                  />
                )}
                <span className="truncate">{tab.title}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}
