import { useState } from "react"
import { Target01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type { Initiative, InitiativePerson } from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamLabel } from "@/lib/team-labels"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { parseTargetDateInput } from "@/lib/target-dates"
import {
  AssigneeMark,
  IssueIcon,
  IssuePicker,
  PriorityMark,
} from "@/components/issues/issue-controls"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button, propertyButtonClassName } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  initiativePriorities,
  initiativeStatuses,
  targetLabel,
} from "@/lib/initiatives"
import { cn } from "@/lib/utils"
import { directoryControlClassName } from "@/components/ui/directory-table"
import { tablePropertyIconClassName } from "@/components/ui/table-property-control"

export const initiativeChip =
  "h-6 max-w-full gap-1.5 rounded-full bg-muted/65 px-2 text-xs font-normal text-muted-foreground"
export const initiativePrimary =
  "h-7 rounded-full bg-[#5e6ad2] px-3 text-xs font-normal text-white hover:bg-[#6e79e1]"
export function InitiativeMark({
  item,
  className,
}: {
  item: { name: string; icon: Initiative["icon"] }
  className?: string
}) {
  return item.icon.kind === "icon" && item.icon.value === "Target01Icon" ? (
    <HugeiconsIcon
      icon={Target01Icon}
      strokeWidth={1.8}
      style={{ color: item.icon.color }}
      className={cn("size-4 shrink-0", className)}
    />
  ) : (
    <TeamSidebarIcon
      icon={item.icon}
      name={item.name || "Initiative"}
      className={className}
    />
  )
}
export function InitiativeStatusMark({
  status,
}: {
  status: Initiative["status"]
}) {
  return (
    <HugeiconsIcon
      icon={Target01Icon}
      strokeWidth={1.8}
      className={cn(
        "size-3.5 shrink-0",
        status === "Active"
          ? "text-yellow-500"
          : status === "Completed"
            ? "text-emerald-500"
            : status === "Canceled"
              ? "text-muted-foreground/60"
              : "text-muted-foreground"
      )}
    />
  )
}
export function InitiativeHealthMark({
  health,
  iconOnly = false,
}: {
  health: string
  iconOnly?: boolean
}) {
  return (
    <span
      title={health}
      className={cn(
        "inline-flex items-center gap-2",
        health === "On track"
          ? "text-emerald-500"
          : health === "Off track"
            ? "text-red-500"
            : health === "At risk"
              ? "text-amber-500"
              : "text-muted-foreground"
      )}
    >
      <IssueIcon
        name={
          health === "On track"
            ? "done"
            : health === "Off track"
              ? "urgent"
              : "clock"
        }
      />
      {!iconOnly && health}
    </span>
  )
}

export function TargetPicker({
  value,
  onChange,
  label,
  compact = false,
  emptyLabel = "Target date",
  plain = false,
  disabled = false,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  compact?: boolean
  emptyLabel?: string
  plain?: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const year = new Date().getFullYear()
  const [selectedYear, setSelectedYear] = useState(
    Number(value.slice(0, 4)) || year
  )
  const [input, setInput] = useState(value ? targetLabel(value) : "")
  const [error, setError] = useState("")
  const [precision, setPrecision] = useState(
    /-Q/.test(value) || !value
      ? "Quarter"
      : /-H/.test(value)
        ? "Half-year"
        : value.length === 4
          ? "Year"
          : value.length === 7
            ? "Month"
            : "Day"
  )
  const dateLabel = label.toLowerCase().includes("start")
    ? "Start date"
    : "Target date"
  function choose(next: string) {
    onChange(next)
    setOpen(false)
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setInput(value ? targetLabel(value) : "")
          setError("")
          setSelectedYear(Number(value.slice(0, 4)) || year)
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant={compact ? "ghost" : "secondary"}
            size="sm"
            aria-label={label}
            disabled={disabled}
            className={cn(
              initiativeChip,
              compact && directoryControlClassName,
              compact && !value && tablePropertyIconClassName,
              plain && propertyButtonClassName,
              plain && value && "text-foreground"
            )}
          />
        }
      >
        <IssueIcon name="date" />
        {value ? targetLabel(value) : !compact && emptyLabel}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={plain ? "left" : "bottom"}
        className="w-[320px] max-w-[calc(100vw-24px)] gap-3 rounded-xl p-3"
      >
        <label className="text-xs text-muted-foreground">
          {dateLabel}
          <Input
            autoFocus
            aria-label={`Set ${dateLabel.toLowerCase()}`}
            placeholder="Try: May 2027, Q4, 05/20/2027"
            value={input}
            onChange={(event) => {
              setInput(event.target.value)
              setError("")
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                const next = parseTargetDateInput(input)
                if (next === null)
                  setError("Enter a date, month, quarter, half-year, or year.")
                else choose(next)
              }
            }}
            className="mt-2 h-8 text-xs"
          />
        </label>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <Tabs value={precision} onValueChange={setPrecision}>
          <TabsList className="w-full justify-between gap-0.5">
            {["Day", "Month", "Quarter", "Half-year", "Year"].map((mode) => (
              <TabsTrigger key={mode} value={mode} className="px-2 text-xs">
                {mode}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center justify-between border-t border-border/40 pt-3">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous target year"
            onClick={() => setSelectedYear(selectedYear - 1)}
          >
            <IssueIcon name="down" className="rotate-90" />
          </Button>
          <span className="text-xs">{selectedYear}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next target year"
            onClick={() => setSelectedYear(selectedYear + 1)}
          >
            <IssueIcon name="down" className="-rotate-90" />
          </Button>
        </div>
        {precision === "Day" ? (
          <Input
            aria-label={`Choose ${dateLabel.toLowerCase()} day`}
            type="date"
            value={/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ""}
            onChange={(event) => {
              if (event.target.value) choose(event.target.value)
            }}
          />
        ) : (
          <div className="max-h-56 space-y-3 overflow-y-auto">
            {[selectedYear - 1, selectedYear, selectedYear + 1].map(
              (shownYear) => (
                <div key={shownYear}>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {shownYear}
                  </p>
                  <div
                    className={cn(
                      "grid gap-1",
                      precision === "Half-year"
                        ? "grid-cols-2"
                        : precision === "Year"
                          ? "grid-cols-1"
                          : "grid-cols-4"
                    )}
                  >
                    {(precision === "Month"
                      ? Array.from({ length: 12 }, (_, index) => ({
                          label: new Date(2000, index, 1).toLocaleDateString(
                            "en",
                            { month: "short" }
                          ),
                          value: `${shownYear}-${String(index + 1).padStart(2, "0")}`,
                        }))
                      : precision === "Quarter"
                        ? [1, 2, 3, 4].map((q) => ({
                            label: `Q${q}`,
                            value: `${shownYear}-Q${q}`,
                          }))
                        : precision === "Half-year"
                          ? [1, 2].map((h) => ({
                              label: `H${h}`,
                              value: `${shownYear}-H${h}`,
                            }))
                          : [
                              {
                                label: String(shownYear),
                                value: String(shownYear),
                              },
                            ]
                    ).map((option) => (
                      <Button
                        key={option.value}
                        variant={
                          value === option.value ? "default" : "secondary"
                        }
                        size="sm"
                        className="rounded-full text-xs"
                        aria-label={`${option.label}${precision === "Year" ? "" : ` ${shownYear}`}`}
                        aria-pressed={value === option.value}
                        onClick={() => choose(option.value)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="justify-start rounded-md text-xs"
          onClick={() => choose(String(selectedYear))}
        >
          End of {selectedYear}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="justify-start rounded-md text-xs text-muted-foreground"
          onClick={() => choose("")}
        >
          Remove target date
        </Button>
      </PopoverContent>
    </Popover>
  )
}

export function InitiativePropertyPicker({
  item,
  property,
  people,
  teams,
  labels,
  onChange,
  compact = false,
  disabled = false,
  detail = false,
}: {
  item: Omit<Initiative, "number">
  property: "status" | "priority" | "owner" | "target" | "labels" | "teams"
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  labels: Array<TeamLabel>
  onChange: (patch: Partial<Initiative>) => void
  compact?: boolean
  disabled?: boolean
  detail?: boolean
}) {
  const suffix = item.name ? ` for ${item.name}` : ""
  const owner = people.find((person) => person.id === item.ownerId)
  const className = cn(
    initiativeChip,
    compact && directoryControlClassName,
    compact &&
      (property === "priority" || (property === "owner" && !owner)) &&
      tablePropertyIconClassName,
    detail && propertyButtonClassName,
    detail &&
      (property === "status" ||
        (property === "priority" && item.priority !== "No priority") ||
        (property === "owner" && item.ownerId) ||
        (property === "labels" && item.labelIds.length) ||
        (property === "teams" && item.teamIds.length)) &&
      "text-foreground"
  )
  let control
  if (property === "target")
    control = (
      <TargetPicker
        value={item.targetDate}
        compact={compact}
        onChange={(targetDate) => onChange({ targetDate })}
        label={`Change initiative target date${suffix}`}
        plain={detail}
        emptyLabel={detail ? "Add target date" : "Target date"}
      />
    )
  else if (property === "status")
    control = (
      <IssuePicker
        side={detail ? "left" : "bottom"}
        label={`Change status${suffix}`}
        value={item.status}
        options={initiativeStatuses.map((status) => ({
          value: status,
          label: status,
          icon: <InitiativeStatusMark status={status} />,
        }))}
        onChange={(status) =>
          onChange({ status: status as Initiative["status"] })
        }
        className={className}
      >
        <InitiativeStatusMark status={item.status} />
        {item.status}
      </IssuePicker>
    )
  else if (property === "priority")
    control = (
      <IssuePicker
        side={detail ? "left" : "bottom"}
        label={`Change priority${suffix}`}
        value={item.priority}
        placeholder="Set priority…"
        options={initiativePriorities.map((priority) => ({
          value: priority,
          label: priority,
          icon: <PriorityMark priority={priority} />,
        }))}
        onChange={(priority) =>
          onChange({ priority: priority as Initiative["priority"] })
        }
        className={className}
      >
        <PriorityMark priority={item.priority} />
        {!compact &&
          (item.priority === "No priority"
            ? detail
              ? "No priority"
              : "Priority"
            : item.priority)}
      </IssuePicker>
    )
  else if (property === "owner")
    control = (
      <IssuePicker
        side={detail ? "left" : "bottom"}
        label={`Change initiative owner${suffix}`}
        placeholder="Assign owner…"
        value={item.ownerId}
        options={[
          { value: "", label: "No owner", icon: <AssigneeMark /> },
          ...people.map((person) => ({
            value: person.id,
            label: person.name,
            icon: <AssigneeMark name={person.name} image={person.image} />,
          })),
        ]}
        onChange={(ownerId) => onChange({ ownerId })}
        className={className}
      >
        <AssigneeMark name={owner?.name} image={owner?.image} />
        {(owner || !compact) && (
          <span className="truncate">
            {owner?.name ?? (detail ? "Add owner" : "Owner")}
          </span>
        )}
      </IssuePicker>
    )
  else {
    const chosen = property === "labels" ? item.labelIds : item.teamIds
    const options =
      property === "labels"
        ? labels.map((label) => ({
            value: label.id,
            label: label.name,
            icon: (
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: label.color }}
              />
            ),
          }))
        : teams.map((team) => ({
            value: team.id,
            label: team.name,
            icon: <TeamSidebarIcon icon={team.icon} name={team.name} />,
          }))
    control = (
      <IssuePicker
        side={detail ? "left" : "bottom"}
        multiple
        label={`Change ${property === "labels" ? "labels" : "contributing teams"}${suffix}`}
        placeholder={property === "labels" ? "Find labels…" : "Find teams…"}
        value={chosen.join(",")}
        options={options}
        onChange={(value) =>
          onChange({
            [property === "labels" ? "labelIds" : "teamIds"]: value
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean),
          })
        }
        className={className}
        footer={
          !options.length ? (
            <p className="p-2 text-xs text-muted-foreground">
              {property === "labels"
                ? "Create initiative labels in workspace settings."
                : "No teams available."}
            </p>
          ) : undefined
        }
      >
        <IssueIcon name={property === "labels" ? "label" : "person"} />
        <span className="truncate">
          {chosen.length
            ? options
                .filter((option) => chosen.includes(option.value))
                .map((option) => option.label)
                .join(", ") || `${chosen.length} selected`
            : property === "labels"
              ? detail
                ? "Add label"
                : "Labels"
              : "Contributing teams"}
        </span>
      </IssuePicker>
    )
  }
  return (
    <fieldset
      disabled={disabled}
      className={cn(
        "contents border-0 p-0",
        disabled && "pointer-events-none opacity-60"
      )}
    >
      {control}
    </fieldset>
  )
}
