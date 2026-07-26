"use client"

import * as React from "react"
import { Archive01Icon, Edit02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import type { AgentThreadRecord } from "@/application/agents/agent-store"
import { useAgent } from "@/components/agent/agent-provider"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

type HistoryGroup = {
  label: string
  threads: Array<AgentThreadRecord>
}

function formatHistoryAge(date: Date) {
  const elapsed = Math.max(0, Date.now() - date.getTime())
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  const month = 30 * day

  if (elapsed < minute) return "Now"
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}min`
  if (elapsed < day) return `${Math.floor(elapsed / hour)}h`
  if (elapsed < month) return `${Math.floor(elapsed / day)}d`
  return `${Math.floor(elapsed / month)}mo`
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function groupThreads(threads: Array<AgentThreadRecord>): Array<HistoryGroup> {
  const now = new Date()
  const today = startOfDay(now)
  const day = 86_400_000
  const groups = new Map<string, Array<AgentThreadRecord>>()
  for (const thread of threads) {
    const age = today - startOfDay(thread.lastActivityAt)
    const label =
      age <= 0
        ? "Today"
        : age <= day
          ? "Yesterday"
          : age <= 7 * day
            ? "Last 7 days"
            : age <= 30 * day
              ? "Last 30 days"
              : "Older"
    const group = groups.get(label) ?? []
    group.push(thread)
    groups.set(label, group)
  }
  return ["Today", "Yesterday", "Last 7 days", "Last 30 days", "Older"]
    .map((label) => ({ label, threads: groups.get(label) ?? [] }))
    .filter((group) => group.threads.length > 0)
}

function HistoryContents() {
  const {
    archiveThread,
    eventsByThread,
    historyOpen,
    openThread,
    renameThread,
    reopenThread,
    runningThreadIds,
    threads,
  } = useAgent()
  const [query, setQuery] = React.useState("")
  const [renamingId, setRenamingId] = React.useState<string | null>(null)
  const [renameValue, setRenameValue] = React.useState("")
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filtered = threads
    .filter((thread) =>
      normalizedQuery
        ? thread.title.toLocaleLowerCase().includes(normalizedQuery)
        : true
    )
    .sort(
      (left, right) =>
        right.lastActivityAt.getTime() - left.lastActivityAt.getTime()
    )
  const groups = groupThreads(filtered)

  if (!historyOpen) return null

  return (
    <Command
      shouldFilter={false}
      className="min-h-0 flex-1 rounded-none bg-transparent p-0 [&_[data-slot=command-input-wrapper]]:p-0 [&_[data-slot=command-input]]:px-3 [&_[data-slot=input-group-addon]]:hidden [&_[data-slot=input-group]]:h-9! [&_[data-slot=input-group]]:rounded-none [&_[data-slot=input-group]]:border-0 [&_[data-slot=input-group]]:border-b [&_[data-slot=input-group]]:border-border/60 [&_[data-slot=input-group]]:bg-transparent"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        showSearchIcon={false}
        placeholder="Chat history"
        aria-label="Chat history"
        className="h-8 text-sm"
      />
      <CommandList
        aria-label="Chat history conversations"
        className="max-h-none min-h-0 flex-1 overscroll-contain px-2 pt-1 pb-2"
      >
        <CommandEmpty className="px-3 py-8 text-center text-sm text-muted-foreground">
          No conversations found.
        </CommandEmpty>
        {groups.map((group) => (
          <CommandGroup
            key={group.label}
            heading={group.label}
            className="p-0 pb-1 **:[[cmdk-group-heading]]:px-2.5 **:[[cmdk-group-heading]]:py-1 **:[[cmdk-group-heading]]:text-xs **:[[cmdk-group-heading]]:font-normal **:[[cmdk-group-heading]]:tracking-normal **:[[cmdk-group-heading]]:normal-case"
          >
            {group.threads.map((thread) => (
              <HistoryThreadRow
                key={thread.id}
                thread={thread}
                failed={
                  thread.lastRunState === "failed" ||
                  Boolean(
                    eventsByThread[thread.id]?.some(
                      (event) => event.type === "run.failed"
                    )
                  )
                }
                running={runningThreadIds.has(thread.id)}
                renaming={renamingId === thread.id}
                renameValue={renameValue}
                setRenameValue={setRenameValue}
                cancelRename={() => setRenamingId(null)}
                commitRename={() => {
                  if (!renameValue.trim()) return
                  void renameThread(thread.id, renameValue.trim())
                  setRenamingId(null)
                }}
                open={() => void openThread(thread.id)}
                beginRename={() => {
                  setRenamingId(thread.id)
                  setRenameValue(thread.title)
                }}
                toggleArchive={() =>
                  void (thread.status === "archived"
                    ? reopenThread(thread.id)
                    : archiveThread(thread.id))
                }
              />
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  )
}

function HistoryThreadRow({
  thread,
  failed,
  running,
  renaming,
  renameValue,
  setRenameValue,
  cancelRename,
  commitRename,
  open,
  beginRename,
  toggleArchive,
}: {
  thread: AgentThreadRecord
  failed: boolean
  running: boolean
  renaming: boolean
  renameValue: string
  setRenameValue: (value: string) => void
  cancelRename: () => void
  commitRename: () => void
  open: () => void
  beginRename: () => void
  toggleArchive: () => void
}) {
  return (
    <CommandItem
      value={`${thread.title} ${thread.id}`}
      onSelect={open}
      className="group h-7 min-h-7 rounded-full px-2.5 py-0 text-sm [&>svg:last-child]:hidden"
    >
      {running ? (
        <Spinner className="size-3.5 shrink-0" />
      ) : failed || thread.status === "archived" ? (
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full bg-muted-foreground/35",
            thread.status === "archived" && "ring-1 ring-border",
            failed && "bg-destructive"
          )}
          aria-label={failed ? "Failed" : undefined}
        />
      ) : null}
      {renaming ? (
        <Input
          autoFocus
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={cancelRename}
          onKeyDown={(event) => {
            if (event.key === "Escape") cancelRename()
            if (event.key === "Enter") commitRename()
          }}
          className="h-6 flex-1 rounded-full text-sm"
          aria-label="Conversation title"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-left text-sm">
          {thread.title}
          {failed ? (
            <span className="ml-2 text-xs text-destructive">Failed</span>
          ) : null}
        </span>
      )}
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground group-focus-within:hidden group-hover:hidden">
        {formatHistoryAge(thread.lastActivityAt)}
      </span>
      <div className="hidden items-center group-focus-within:flex group-hover:flex">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Rename ${thread.title}`}
          onClick={(event) => {
            event.stopPropagation()
            beginRename()
          }}
        >
          <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={
            thread.status === "archived"
              ? `Reopen ${thread.title}`
              : `Archive ${thread.title}`
          }
          onClick={(event) => {
            event.stopPropagation()
            toggleArchive()
          }}
        >
          <HugeiconsIcon icon={Archive01Icon} strokeWidth={2} />
        </Button>
      </div>
    </CommandItem>
  )
}

export function AgentHistory() {
  const { historyOpen, setHistoryOpen } = useAgent()
  const [narrow, setNarrow] = React.useState(false)

  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)")
    const update = () => setNarrow(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  if (narrow) {
    return (
      <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <SheetContent
          side="right"
          showCloseButton
          className="w-full sm:max-w-full"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Agent history</SheetTitle>
          </SheetHeader>
          <HistoryContents />
        </SheetContent>
      </Sheet>
    )
  }

  return historyOpen ? (
    <aside
      className="pointer-events-auto absolute -right-2 bottom-0 z-50 flex h-[min(490px,calc(100%_-_0.75rem))] w-[min(420px,calc(100%_-_1.5rem))] flex-col overflow-hidden rounded-2xl border bg-popover shadow-2xl"
      aria-label="Agent history"
    >
      <HistoryContents />
    </aside>
  ) : null
}
