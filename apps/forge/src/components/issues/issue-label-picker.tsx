import { useLayoutEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { IssueIcon, issueChip, issuePropertyControl } from "./issue-controls"
import type { TeamIssue } from "@/lib/team-issues"
import { CheckboxMark } from "@/components/ui/checkbox-mark"
import {
  activityReferenceIssues,
  activityReferenceSearch,
} from "@/lib/issue-activity"
import { Button } from "@/components/ui/button"
import { ActionHint } from "@/components/ui/action-icon-button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { cn } from "@/lib/utils"

export function IssueLabelPicker({
  value,
  labels,
  colors,
  issues,
  team,
  onChange,
}: {
  value: string
  labels: Array<string>
  colors: Record<string, string>
  issues: Array<TeamIssue>
  team: { slug: string; name: string }
  onChange: (value: string) => void
}) {
  const anchor = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const focusAfterChange = useRef<string | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const selected = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  const options = [...new Set([...selected, ...labels])]
  const matches = options.filter((name) =>
    name.toLowerCase().includes(query.trim().toLowerCase())
  )
  const chosen = matches.filter((name) => selected.includes(name))
  const available = matches.filter((name) => !selected.includes(name))
  useLayoutEffect(() => {
    const name = focusAfterChange.current
    if (name === null) return
    focusAfterChange.current = null
    const target = Array.from(
      list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
    ).find((item) => item.dataset.labelName === name)
    if (target) target.focus()
    else
      list.current?.parentElement
        ?.querySelector<HTMLInputElement>("input")
        ?.focus()
  }, [value])
  function toggle(name: string, keepFocus = false) {
    if (keepFocus) focusAfterChange.current = name
    onChange(
      (selected.includes(name)
        ? selected.filter((item) => item !== name)
        : [...selected, name]
      ).join(", ")
    )
  }
  function focusOption(index: number, from: HTMLElement) {
    const items = from
      .closest("[data-label-picker]")
      ?.querySelectorAll<HTMLElement>('[role="option"]')
    if (items?.length) items[(index + items.length) % items.length].focus()
  }
  function option(name: string) {
    const checked = selected.includes(name)
    const count = activityReferenceIssues(issues, "label", name).length
    return (
      <HoverCard key={name}>
        <HoverCardTrigger
          delay={400}
          closeDelay={200}
          render={
            <button
              type="button"
              role="option"
              aria-selected={checked}
              data-label-name={name}
              onClick={() => toggle(name, true)}
              onKeyDown={(event) => {
                const items = Array.from(
                  event.currentTarget
                    .closest('[role="listbox"]')
                    ?.querySelectorAll<HTMLElement>('[role="option"]') ?? []
                )
                const index = items.indexOf(event.currentTarget)
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault()
                  focusOption(
                    index + (event.key === "ArrowDown" ? 1 : -1),
                    event.currentTarget
                  )
                } else if (event.key === "Home" || event.key === "End") {
                  event.preventDefault()
                  focusOption(
                    event.key === "Home" ? 0 : -1,
                    event.currentTarget
                  )
                }
              }}
              className="group/label flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent data-popup-open:bg-accent"
            />
          }
        >
          <CheckboxMark
            checked={checked}
            className={cn(
              "opacity-0 group-hover/label:opacity-100 group-focus-visible/label:opacity-100 group-data-popup-open/label:opacity-100",
              checked && "opacity-100"
            )}
          />
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full bg-muted-foreground"
            style={{ backgroundColor: colors[name] }}
          />
          <span className="min-w-0 truncate">{name}</span>
        </HoverCardTrigger>
        <HoverCardContent
          role="dialog"
          aria-modal={false}
          aria-label={`Label preview: ${name}`}
          side="right"
          align="start"
          sideOffset={10}
          className="w-72 max-w-[calc(100vw-32px)] space-y-3 rounded-lg p-3 motion-reduce:animate-none"
        >
          <div className="flex items-center gap-2 text-[13px] font-medium">
            <span
              className="size-2 shrink-0 rounded-full bg-muted-foreground"
              style={{ backgroundColor: colors[name] }}
            />
            {name}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2 text-xs text-muted-foreground">
            <Link
              to="/teams/$teamSlug/issues"
              params={{ teamSlug: team.slug }}
              search={activityReferenceSearch("label", name)}
              className="inline-flex items-center gap-1.5 rounded-sm no-underline outline-none hover:text-foreground hover:no-underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              <IssueIcon name="copy" />
              {count} labeled {count === 1 ? "issue" : "issues"}
            </Link>
            <span className="truncate">{team.name}</span>
          </div>
        </HoverCardContent>
      </HoverCard>
    )
  }
  const canCreate =
    query.trim() &&
    !options.some((name) => name.toLowerCase() === query.trim().toLowerCase())
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setQuery("")
      }}
    >
      <div ref={anchor} className="flex flex-wrap items-center gap-1">
        {selected.map((name) => (
          <ActionHint key={name} label={`Change label ${name}`} disabled={open}>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  aria-label={`Change label ${name}`}
                  className={cn(
                    issueChip,
                    "gap-1.5 border border-border/70 bg-transparent text-[13px] text-foreground"
                  )}
                />
              }
            >
              <span
                className="size-2 shrink-0 rounded-full bg-muted-foreground"
                style={{ backgroundColor: colors[name] }}
              />
              <span className="max-w-32 truncate">{name}</span>
            </PopoverTrigger>
          </ActionHint>
        ))}
        <ActionHint label="Add labels" disabled={open}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="secondary"
                size="sm"
                aria-label="Add labels"
                className={cn(
                  issueChip,
                  issuePropertyControl,
                  selected.length > 0 &&
                    "size-7 justify-center rounded-full p-0"
                )}
              />
            }
          >
            <IssueIcon
              name={selected.length ? "add" : "label"}
              className="size-4"
            />
            {!selected.length && <span className="truncate">Add label</span>}
          </PopoverTrigger>
        </ActionHint>
      </div>
      <PopoverContent
        anchor={anchor}
        side="left"
        sideOffset={6}
        align="start"
        className="issue-menu w-60 gap-0 rounded-lg p-1"
        initialFocus={true}
        data-label-picker
      >
        <input
          autoFocus
          aria-label="Change or add labels"
          placeholder="Change or add labels…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              focusOption(
                event.key === "ArrowDown" ? 0 : -1,
                event.currentTarget
              )
            } else if (event.key === "Enter") {
              event.preventDefault()
              const first = [...chosen, ...available][0]
              if (first) toggle(first)
              else if (canCreate) {
                toggle(query.trim())
                setQuery("")
              }
            }
          }}
          className="-mx-1 -mt-1 mb-1 h-9 w-[calc(100%+8px)] border-b border-border/50 bg-transparent px-3 text-[13px] outline-none"
        />
        <div
          ref={list}
          role="listbox"
          aria-label="Labels"
          aria-multiselectable="true"
          className="max-h-64 overflow-y-auto"
        >
          {chosen.length > 0 && (
            <div
              role="group"
              aria-label="Selected labels"
              className="mb-1 border-b border-border/50 pb-1"
            >
              {chosen.map(option)}
            </div>
          )}
          {available.length > 0 && (
            <div role="group" aria-label={`${team.name} labels`}>
              <div className="px-2 py-2 text-xs text-muted-foreground">
                {team.name} labels
              </div>
              {available.map(option)}
            </div>
          )}
          {!matches.length && !canCreate && (
            <p className="p-3 text-xs text-muted-foreground">No labels found</p>
          )}
        </div>
        {canCreate && (
          <Button
            variant="ghost"
            className="h-8 w-full justify-start rounded-md text-xs"
            onClick={() => {
              toggle(query.trim())
              setQuery("")
            }}
          >
            <IssueIcon name="add" /> Use “{query.trim()}”
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
