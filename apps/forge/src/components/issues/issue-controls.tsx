import { useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  AlertSquareIcon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  ArrowUpDownIcon,
  Calendar03Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Clock05Icon,
  Comment01Icon,
  Copy01Icon,
  CropIcon,
  CubeIcon,
  Delete02Icon,
  Download04Icon,
  File01Icon,
  FilterHorizontalIcon,
  GitBranchIcon,
  Layers01Icon,
  LayoutGridIcon,
  Link01Icon,
  Maximize01Icon,
  Menu01Icon,
  MoreHorizontalIcon,
  Notification01Icon,
  Paperclip,
  RepeatIcon,
  Search01Icon,
  SidebarRightIcon,
  SignalFull02Icon,
  SignalLow02Icon,
  SignalMedium02Icon,
  SlidersHorizontalIcon,
  SmilePlusIcon,
  StarIcon,
  Tag01Icon,
  Tick02Icon,
  UserGroup03Icon,
  ZapIcon,
} from "@hugeicons/core-free-icons"
import type { ReactNode } from "react"
import type { IssueDisplay } from "@/lib/team-issues"
import type { TeamStatus } from "@/lib/team-statuses"
import { CheckboxMark } from "@/components/ui/checkbox-mark"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { OptionSelect } from "@/components/ui/option-select"
import { IssueStatusIcon } from "@/components/issue-status-icon"
import { ActionHint } from "@/components/ui/action-icon-button"
import { cn } from "@/lib/utils"

const icons = {
  add: Add01Icon,
  down: ArrowDown01Icon,
  up: ArrowUp01Icon,
  branch: GitBranchIcon,
  prompt: ZapIcon,
  reaction: SmilePlusIcon,
  sort: ArrowUpDownIcon,
  date: Calendar03Icon,
  close: Cancel01Icon,
  done: CheckmarkCircle02Icon,
  clock: Clock05Icon,
  copy: Copy01Icon,
  project: CubeIcon,
  file: File01Icon,
  filter: FilterHorizontalIcon,
  priority: SignalFull02Icon,
  medium: SignalMedium02Icon,
  low: SignalLow02Icon,
  urgent: AlertSquareIcon,
  layers: Layers01Icon,
  board: LayoutGridIcon,
  link: Link01Icon,
  expand: Maximize01Icon,
  list: Menu01Icon,
  more: MoreHorizontalIcon,
  bell: Notification01Icon,
  attach: Paperclip,
  repeat: RepeatIcon,
  search: Search01Icon,
  settings: SlidersHorizontalIcon,
  crop: CropIcon,
  delete: Delete02Icon,
  download: Download04Icon,
  comment: Comment01Icon,
  details: SidebarRightIcon,
  star: StarIcon,
  label: Tag01Icon,
  check: Tick02Icon,
  person: UserGroup03Icon,
  spark: ZapIcon,
}
export function IssueIcon({
  name,
  className,
}: {
  name: keyof typeof icons
  className?: string
}) {
  return (
    <HugeiconsIcon
      icon={icons[name]}
      strokeWidth={1.7}
      className={cn("size-3.5 shrink-0", className)}
    />
  )
}
export const issueChip = "gap-1 rounded-full px-2 text-xs font-normal"
export const issuePropertyControl =
  "max-w-full gap-2 border-0 bg-transparent text-[13px] text-muted-foreground"
export const issuePrimary =
  "rounded-full bg-[#5e6ad2] px-3 text-xs text-white hover:bg-[#6e79e1]"
export function StatusMark({
  id,
  statuses,
}: {
  id: string
  statuses: Array<TeamStatus>
}) {
  const status = statuses.find((item) => item.id === id)
  return (
    <IssueStatusIcon
      group={status?.group ?? "unstarted"}
      color={status?.color ?? "#bec2c8"}
      review={status?.name === "In Review"}
    />
  )
}
export function PriorityMark({ priority }: { priority: string }) {
  return (
    <IssueIcon
      name={
        priority === "No priority"
          ? "more"
          : priority === "Urgent"
            ? "urgent"
            : priority === "Low"
              ? "low"
              : priority === "Medium"
                ? "medium"
                : "priority"
      }
    />
  )
}
export function AssigneeMark({
  name,
  image,
}: {
  name?: string
  image?: string | null
}) {
  return name ? (
    <Avatar aria-hidden="true" className="size-4">
      <AvatarImage src={image ?? undefined} alt="" />
      <AvatarFallback className="bg-emerald-600 text-[8px] font-medium text-white">
        {name
          .split(/\s+/)
          .slice(0, 2)
          .map((part) => part[0])
          .join("")}
      </AvatarFallback>
    </Avatar>
  ) : (
    <IssueIcon name="person" />
  )
}
export type PickerOption = { value: string; label: string; icon?: ReactNode }
export function IssuePicker({
  label,
  shortcut,
  placeholder,
  value,
  options,
  onChange,
  children,
  className,
  multiple = false,
  allowCreate = false,
  footer,
  open: controlledOpen,
  onOpenChange: controlledChange,
  side = "bottom",
}: {
  label: string
  shortcut?: string
  placeholder?: string
  value: string
  options: Array<PickerOption>
  onChange: (value: string) => void
  children: ReactNode
  className?: string
  multiple?: boolean
  allowCreate?: boolean
  footer?: ReactNode
  open?: boolean
  onOpenChange?: (value: boolean) => void
  side?: "top" | "bottom" | "left" | "right"
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const [search, setSearch] = useState("")
  const open = controlledOpen ?? localOpen
  const setOpen = controlledChange ?? setLocalOpen
  const selected = multiple
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : [value]
  const shown = options.filter((option) =>
    option.label.toLowerCase().includes(search.toLowerCase())
  )
  function choose(next: string) {
    onChange(
      multiple
        ? (selected.includes(next)
            ? selected.filter((item) => item !== next)
            : [...selected, next]
          ).join(", ")
        : next
    )
    if (!multiple) setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setSearch("")
      }}
    >
      <ActionHint
        label={label.replace(/ for .*/, "")}
        shortcut={shortcut}
        disabled={open}
      >
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label={label}
              className={cn(issueChip, className)}
            />
          }
        >
          {children}
        </PopoverTrigger>
      </ActionHint>
      <PopoverContent
        align="start"
        side={side}
        className="issue-menu w-52 gap-0 rounded-xl p-1"
        initialFocus={true}
        onKeyDown={(event) => {
          if (
            !search &&
            !event.metaKey &&
            !event.ctrlKey &&
            /^[0-9]$/.test(event.key) &&
            shown[Number(event.key)]
          ) {
            event.preventDefault()
            choose(shown[Number(event.key)].value)
          }
        }}
      >
        <input
          autoFocus
          aria-label={placeholder ?? label}
          placeholder={placeholder ?? `${label}…`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="-mx-1 -mt-1 mb-1 h-9 w-[calc(100%+8px)] border-b border-border/50 bg-transparent px-3 text-[13px] outline-none"
          onKeyDown={(event) => {
            if (event.key === "Enter" && shown[0]) {
              event.preventDefault()
              choose(shown[0].value)
            }
            if (event.key === "ArrowDown") {
              event.preventDefault()
              event.currentTarget.parentElement
                ?.querySelector<HTMLElement>('[role="option"]')
                ?.focus()
            }
          }}
        />
        <div
          role="listbox"
          aria-label={label}
          aria-multiselectable={multiple || undefined}
          className="max-h-64 overflow-y-auto"
        >
          {shown.map((option, index) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected.includes(option.value)}
              onClick={() => choose(option.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault()
                  const items =
                    event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                      '[role="option"]'
                    )
                  items?.[
                    (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      shown.length) %
                      shown.length
                  ]?.focus()
                }
              }}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none hover:bg-accent focus-visible:bg-accent",
                selected.includes(option.value) && "bg-accent/70"
              )}
            >
              {option.icon}
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              <CheckboxMark checked={selected.includes(option.value)} />
            </button>
          ))}
          {!shown.length && (
            <p className="p-3 text-xs text-muted-foreground">No results</p>
          )}
          {allowCreate &&
            search.trim() &&
            !options.some(
              (option) =>
                option.label.toLowerCase() === search.trim().toLowerCase()
            ) && (
              <Button
                variant="ghost"
                className="w-full justify-start text-xs"
                onClick={() => {
                  choose(search.trim())
                  setSearch("")
                }}
              >
                <IssueIcon name="add" /> Use “{search.trim()}”
              </Button>
            )}
        </div>
        {footer && (
          <div className="mt-1 border-t border-border/50 pt-1">{footer}</div>
        )}
      </PopoverContent>
    </Popover>
  )
}
export function IssueToggle({
  label,
  checked,
  onChange,
  switchFirst = false,
}: {
  switchFirst?: boolean
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex min-h-8 items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>{label}</span>
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={onChange}
        className={cn(
          "data-checked:border-[#5e6ad2] data-checked:bg-[#5e6ad2] [&_[data-slot=switch-thumb]]:bg-white!",
          switchFirst && "order-first"
        )}
      />
    </label>
  )
}
export function IssueDisplayMenu({
  value,
  onChange,
  onReset,
  onSaveDefault,
}: {
  value: IssueDisplay
  onChange: (value: IssueDisplay) => void
  onReset: () => void
  onSaveDefault: () => void
}) {
  function update(patch: Partial<IssueDisplay>) {
    onChange({ ...value, ...patch })
  }
  const groups = [
    "Status",
    "Priority",
    "Assignee",
    "Project",
    "Labels",
    "No grouping",
  ]
  const properties = [
    "ID",
    "Status",
    "Assignee",
    ...(value.layout === "list" ? ["Creator"] : []),
    "Priority",
    "Project",
    "Due date",
    "Milestone",
    "Labels",
    "Links",
    "Time in status",
    "Pull requests",
    "Created",
    "Updated",
  ]
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Display options"
            title="Display options"
            className="rounded-full"
          />
        }
      >
        <IssueIcon name="settings" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="issue-menu w-[300px] max-w-[calc(100vw-24px)] gap-0 rounded-xl p-0"
      >
        <div className="space-y-4 p-4">
          <div
            className="grid grid-cols-2 gap-1.5"
            role="tablist"
            aria-label="Issue layout"
          >
            {(["list", "board"] as const).map((layout) => (
              <Button
                key={layout}
                role="tab"
                aria-selected={value.layout === layout}
                variant="secondary"
                size="sm"
                className={cn(
                  "text-xs font-normal",
                  value.layout === layout &&
                    "bg-foreground/15 ring-1 ring-foreground/10"
                )}
                onClick={() => update({ layout })}
              >
                <IssueIcon name={layout} />
                {layout === "list" ? "List" : "Board"}
              </Button>
            ))}
          </div>
          <div className="space-y-1">
            {(["group", "subgroup", "order"] as const).map((key) => (
              <div
                className="flex h-7 items-center gap-2 text-xs text-muted-foreground"
                key={key}
              >
                <span className="flex-1">
                  {key === "group"
                    ? value.layout === "list"
                      ? "Grouping"
                      : "Columns"
                    : key === "subgroup"
                      ? value.layout === "list"
                        ? "Sub-grouping"
                        : "Rows"
                      : "Ordering"}
                </span>
                {(key === "order" ||
                  (key === "group" && value.layout === "board")) && (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={
                      key === "order" ? "Direction" : "Group ordering"
                    }
                    title="Reverse order"
                    onClick={() =>
                      key === "order"
                        ? update({ descending: !value.descending })
                        : update({ groupDescending: !value.groupDescending })
                    }
                  >
                    <IssueIcon name="sort" />
                  </Button>
                )}
                <OptionSelect
                  size="sm"
                  aria-label={
                    key === "group"
                      ? "Grouping"
                      : key === "subgroup"
                        ? "Sub-grouping"
                        : "Ordering"
                  }
                  value={value[key]}
                  onValueChange={(next) => update({ [key]: next })}
                  className="w-[128px] rounded-lg border-0 bg-secondary py-0 text-xs"
                >
                  {(key === "order"
                    ? [
                        "Priority",
                        "Created",
                        "Updated",
                        "Due date",
                        "Title",
                        "Status",
                      ]
                    : groups
                  ).map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </OptionSelect>
              </div>
            ))}
            <IssueToggle
              label="Order completed by recency"
              checked={value.completedByRecency}
              onChange={(next) => update({ completedByRecency: next })}
            />
          </div>
        </div>
        <div className="border-y border-border/50 px-4 py-2">
          <IssueToggle
            label="Show sub-issues"
            checked={value.showSubIssues}
            onChange={(next) => update({ showSubIssues: next })}
          />
        </div>
        <div className="space-y-2 p-4">
          <p className="text-xs">
            {value.layout === "list" ? "List" : "Board"} options
          </p>
          {value.layout === "list" && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              Nested sub-issues
              <OptionSelect
                size="sm"
                aria-label="Nested sub-issues"
                value={value.nested}
                onValueChange={(next) =>
                  update({ nested: next as IssueDisplay["nested"] })
                }
                className="w-[128px] rounded-lg border-0 bg-secondary py-0"
              >
                <option>Show matching</option>
                <option>Show all</option>
                <option>Hide</option>
              </OptionSelect>
            </div>
          )}
          <IssueToggle
            label={
              value.layout === "list"
                ? "Show empty groups"
                : "Show empty columns"
            }
            checked={value.showEmpty}
            onChange={(next) => update({ showEmpty: next })}
          />
          <p className="pt-1 text-xs text-muted-foreground">
            Display properties
          </p>
          <div className="flex flex-wrap gap-1">
            {properties.map((property) => (
              <Button
                size="sm"
                key={property}
                variant="secondary"
                aria-pressed={
                  property === "Pull requests"
                    ? value.showPullRequests !== false
                    : value.properties.includes(property)
                }
                className={cn(
                  issueChip,
                  "px-2",
                  (
                    property === "Pull requests"
                      ? value.showPullRequests !== false
                      : value.properties.includes(property)
                  )
                    ? "bg-foreground/15 text-foreground"
                    : "text-muted-foreground"
                )}
                onClick={() =>
                  property === "Pull requests"
                    ? update({
                        showPullRequests: value.showPullRequests === false,
                      })
                    : update({
                        properties: value.properties.includes(property)
                          ? value.properties.filter((item) => item !== property)
                          : [...value.properties, property],
                      })
                }
              >
                {property}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-1 border-t border-border/50 px-3 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={onReset}
          >
            Reset
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-[#7d87f5]"
            title="Save the default display for this view"
            onClick={onSaveDefault}
          >
            Set as default
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
