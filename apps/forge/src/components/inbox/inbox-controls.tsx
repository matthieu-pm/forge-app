import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Cancel01Icon,
  CircleIcon,
  CubeIcon,
  FilterIcon,
  Flag01Icon,
  Notification01Icon,
  SlidersHorizontalIcon,
  UserIcon,
} from "@hugeicons/core-free-icons"
import type { ComponentProps, ReactNode } from "react"
import type { InboxEntry } from "@/lib/inbox-state"
import type { InboxFilters, InboxPreferences } from "@/lib/inbox-view"
import {
  emptyInboxFilters,
  inboxStatusTypes,
  matchesInboxFilters,
  notificationTypes,
} from "@/lib/inbox-view"
import { statusGroups } from "@/lib/team-statuses"
import { IssueStatusIcon } from "@/components/issue-status-icon"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { OptionSelect } from "@/components/ui/option-select"
import { Switch } from "@/components/ui/switch"

const rowClass =
  "h-8 min-h-8 rounded-md px-2 py-0 text-[13px] data-highlighted:bg-accent [&>svg]:size-3.5"
const menuClass = "w-56 rounded-xl p-1"
const categories: Array<{
  key: keyof InboxFilters
  label: string
  icon: ComponentProps<typeof HugeiconsIcon>["icon"]
}> = [
  { key: "type", label: "Notification type", icon: Notification01Icon },
  { key: "from", label: "From", icon: UserIcon },
  { key: "project", label: "Project", icon: CubeIcon },
  { key: "priority", label: "Issue priority", icon: Flag01Icon },
  { key: "status", label: "Issue status type", icon: CircleIcon },
]
type FilterOption = { value: string; label: string; count?: number }
function optionsFor(
  key: keyof InboxFilters,
  entries: Array<InboxEntry>
): Array<FilterOption> {
  if (key === "type")
    return notificationTypes.map((type) => ({
      ...type,
      count: entries.filter((entry) =>
        matchesInboxFilters(entry, {
          ...emptyInboxFilters(),
          type: [type.value],
        })
      ).length,
    }))
  if (key === "from")
    return [
      ...new Map(
        entries.flatMap((entry) =>
          entry.events.map((event) => [event.actorId, event.actor] as const)
        )
      ).entries(),
    ]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label))
  if (key === "project")
    return [
      { value: "", label: "No project" },
      ...[
        ...new Set(
          entries.flatMap((entry) =>
            entry.issue?.project ? [entry.issue.project] : []
          )
        ),
      ]
        .sort()
        .map((value) => ({ value, label: value })),
    ]
  if (key === "priority")
    return ["No priority", "Urgent", "High", "Medium", "Low"].map((label) => ({
      value: label.toLowerCase(),
      label,
    }))
  return inboxStatusTypes.map((value) => ({
    value,
    label: value[0].toUpperCase() + value.slice(1),
  }))
}
function FilterSearch(props: ComponentProps<"input">) {
  return (
    <div className="-mx-1 mb-1 flex h-9 items-center border-b border-border/50 px-3">
      <input
        {...props}
        type="search"
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(event.key))
            event.stopPropagation()
        }}
      />
    </div>
  )
}
function OptionIcon({
  field,
  value,
}: {
  field: keyof InboxFilters
  value: string
}) {
  if (field === "status") {
    const group = statusGroups.find((item) => item.id === value)
    if (group) return <IssueStatusIcon group={group.id} color={group.color} />
  }
  if (field === "priority") {
    const level = ["no priority", "low", "medium", "high", "urgent"].indexOf(
      value
    )
    return (
      <svg
        viewBox="0 0 16 16"
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      >
        {level === 4 ? (
          <>
            <rect width="14" height="14" x="1" y="1" rx="3" fill="#f47736" />
            <path
              d="M8 4v4m0 2v1"
              stroke="var(--background)"
              strokeWidth="1.5"
            />
          </>
        ) : level === 0 ? (
          <path
            d="M2 8h2m3 0h2m3 0h2"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        ) : (
          [0, 1, 2].map((bar) => (
            <rect
              key={bar}
              x={2 + bar * 5}
              y={10 - bar * 3}
              width="3"
              height={4 + bar * 3}
              rx=".6"
              fill="currentColor"
              opacity={bar < level ? 1 : 0.25}
            />
          ))
        )}
      </svg>
    )
  }
  return (
    <HugeiconsIcon
      icon={categories.find((category) => category.key === field)!.icon}
      className="size-3.5 text-muted-foreground"
    />
  )
}
function FilterSubmenu({
  field,
  entries,
  value,
  onChange,
}: {
  field: keyof InboxFilters
  entries: Array<InboxEntry>
  value: InboxFilters
  onChange: (next: InboxFilters) => void
}) {
  const [search, setSearch] = useState("")
  const [showAll, setShowAll] = useState(false)
  const options = optionsFor(field, entries)
  const hidden =
    field === "type"
      ? options.filter(
          (option) => !option.count && !value.type.includes(option.value)
        ).length
      : 0
  const shown = options.filter(
    (option) =>
      option.label.toLowerCase().includes(search.toLowerCase()) &&
      (field !== "type" ||
        showAll ||
        search ||
        option.count ||
        value.type.includes(option.value))
  )
  return (
    <>
      <FilterSearch
        aria-label={`Search ${categories.find((category) => category.key === field)!.label}`}
        placeholder="Filter…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      {shown.map((option) => (
        <DropdownMenuCheckboxItem
          key={option.value}
          className={`${rowClass} pr-7`}
          checked={value[field].includes(option.value)}
          closeOnClick={false}
          onCheckedChange={(checked) =>
            onChange({
              ...value,
              [field]: checked
                ? [...value[field], option.value]
                : value[field].filter((item) => item !== option.value),
            })
          }
        >
          <OptionIcon field={field} value={option.value} />
          <span className="min-w-0 flex-1 truncate">{option.label}</span>
          {option.count !== undefined && (
            <span className="ml-3 text-[11px] text-muted-foreground">
              {option.count}
            </span>
          )}
        </DropdownMenuCheckboxItem>
      ))}
      {!shown.length && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          No matching options
        </p>
      )}
      {!!hidden && !showAll && !search && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="rounded-md px-2 py-2 text-xs"
            closeOnClick={false}
            onClick={() => setShowAll(true)}
          >
            {hidden} options not matching any notifications
          </DropdownMenuItem>
        </>
      )}
    </>
  )
}
export function InboxFiltersMenu({
  entries,
  value,
  onChange,
  open,
  onOpenChange,
}: {
  entries: Array<InboxEntry>
  value: InboxFilters
  onChange: (value: InboxFilters) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [search, setSearch] = useState("")
  const filtered = categories.filter((category) =>
    category.label.toLowerCase().includes(search.toLowerCase())
  )
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setSearch("")
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add filter"
            title="Add filter"
            className="rounded-lg text-muted-foreground data-popup-open:bg-muted"
          >
            <HugeiconsIcon icon={FilterIcon} className="size-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className={menuClass}>
        <FilterSearch
          aria-label="Add Filter"
          placeholder="Add Filter…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {filtered.map((category) => (
          <DropdownMenuSub key={category.key}>
            <DropdownMenuSubTrigger
              className={`${rowClass} [&>svg:last-child]:transition-transform motion-reduce:[&>svg:last-child]:transition-none [&[aria-expanded=true]>svg:last-child]:rotate-90`}
            >
              <HugeiconsIcon
                icon={category.icon}
                className="text-muted-foreground"
              />
              {category.label}
              {!!value[category.key].length && (
                <span className="text-[10px] text-muted-foreground">
                  {value[category.key].length}
                </span>
              )}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              className="w-64 max-w-[calc(100vw-24px)] rounded-xl p-1"
              sideOffset={4}
            >
              <FilterSubmenu
                field={category.key}
                entries={entries}
                value={value}
                onChange={onChange}
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
        {!filtered.length && (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            No matching filters
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
export function InboxFilterChips({
  value,
  entries,
  onChange,
}: {
  value: InboxFilters
  entries: Array<InboxEntry>
  onChange: (next: InboxFilters) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5 border-b border-border/40 px-4 py-2">
      {categories.flatMap((category) =>
        value[category.key].map((selected) => (
          <button
            key={`${category.key}:${selected}`}
            className="flex max-w-full items-center gap-1.5 rounded-md border border-border/70 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted focus-visible:outline-ring"
            aria-label={`Remove ${category.label}: ${optionsFor(category.key, entries).find((option) => option.value === selected)?.label ?? selected}`}
            onClick={() =>
              onChange({
                ...value,
                [category.key]: value[category.key].filter(
                  (item) => item !== selected
                ),
              })
            }
          >
            <span className="truncate">
              {optionsFor(category.key, entries).find(
                (option) => option.value === selected
              )?.label ?? selected}
            </span>
            <HugeiconsIcon icon={Cancel01Icon} className="size-3 shrink-0" />
          </button>
        ))
      )}
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto text-xs text-muted-foreground"
        onClick={() => onChange(emptyInboxFilters())}
      >
        Clear
      </Button>
    </div>
  )
}
function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-4 text-[13px]">
      <span className="whitespace-nowrap text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}
export function InboxDisplayOptions({
  value,
  onChange,
}: {
  value: InboxPreferences
  onChange: (changes: Partial<InboxPreferences>) => void
}) {
  const selectClass =
    "h-7 w-32 shrink-0 rounded-lg border border-border/70 bg-muted/70 px-2 text-xs"
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Display options"
            title="Display options"
            className="rounded-lg text-muted-foreground data-popup-open:bg-muted"
          >
            <HugeiconsIcon icon={SlidersHorizontalIcon} className="size-4" />
          </Button>
        }
      />
      <PopoverContent
        align="end"
        className="w-[332px] max-w-[calc(100vw-24px)] gap-0 rounded-xl p-0"
      >
        <div className="space-y-1 px-4 py-3">
          <Setting label="Enable priority inbox">
            <Switch
              size="sm"
              aria-label="Enable priority inbox"
              checked={value.priorityEnabled}
              onCheckedChange={(priorityEnabled) =>
                onChange({ priorityEnabled })
              }
            />
          </Setting>
          {value.priorityEnabled && (
            <>
              <Setting label="Include in priority inbox">
                <OptionSelect
                  aria-label="Include in priority inbox"
                  className={selectClass}
                  value={value.priorityInclude}
                  onValueChange={(priorityInclude) =>
                    onChange({
                      priorityInclude:
                        priorityInclude as InboxPreferences["priorityInclude"],
                    })
                  }
                >
                  <option value="all">All</option>
                  <option value="direct">Assignments & mentions</option>
                  <option value="mentions">Mentions</option>
                </OptionSelect>
              </Setting>
              <Setting label="Badge count">
                <OptionSelect
                  aria-label="Badge count"
                  className={selectClass}
                  value={value.badgeCount}
                  onValueChange={(badgeCount) =>
                    onChange({
                      badgeCount: badgeCount as InboxPreferences["badgeCount"],
                    })
                  }
                >
                  <option value="all">Priority & Other</option>
                  <option value="priority">Priority only</option>
                  <option value="none">None</option>
                </OptionSelect>
              </Setting>
            </>
          )}
        </div>
        <div className="space-y-1 border-y border-border/50 px-4 py-3">
          <Setting label="Group unreads by">
            <OptionSelect
              aria-label="Group unreads by"
              className={selectClass}
              value={value.groupBy}
              onValueChange={(groupBy) =>
                onChange({ groupBy: groupBy as InboxPreferences["groupBy"] })
              }
            >
              <option value="none">No grouping</option>
              <option value="project">Project</option>
              <option value="type">Notification type</option>
            </OptionSelect>
          </Setting>
          <Setting label="Ordering">
            <OptionSelect
              aria-label="Ordering"
              className={selectClass}
              value={value.ordering}
              onValueChange={(ordering) =>
                onChange({ ordering: ordering as InboxPreferences["ordering"] })
              }
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
            </OptionSelect>
          </Setting>
        </div>
        <div className="space-y-1 px-4 py-3">
          <Setting label="Show snoozed">
            <Switch
              size="sm"
              aria-label="Show snoozed"
              checked={value.showSnoozed}
              onCheckedChange={(showSnoozed) => onChange({ showSnoozed })}
            />
          </Setting>
          <Setting label="Show unread first">
            <Switch
              size="sm"
              aria-label="Show unread first"
              checked={value.unreadFirst}
              onCheckedChange={(unreadFirst) => onChange({ unreadFirst })}
            />
          </Setting>
        </div>
      </PopoverContent>
    </Popover>
  )
}
