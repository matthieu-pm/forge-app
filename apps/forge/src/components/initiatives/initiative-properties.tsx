import { useState } from "react"
import { Target01Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import type { Initiative, InitiativePerson } from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamLabel } from "@/lib/team-labels"
import {
  AssigneeMark,
  IssueIcon,
  IssuePicker,
  PriorityMark,
} from "@/components/issues/issue-controls"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button } from "@/components/ui/button"
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
  const [selectedYear, setSelectedYear] = useState(year)
  function choose(next: string) {
    onChange(next)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
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
              plain &&
                "h-7 max-w-full justify-start rounded-md border-0 bg-transparent px-1 text-[13px] font-normal hover:bg-muted/60"
            )}
          />
        }
      >
        <IssueIcon
          name="date"
          className={cn(
            compact &&
              !value &&
              "opacity-0 group-focus-within/directory:opacity-100 group-hover:opacity-100 group-hover/directory:opacity-100"
          )}
        />
        {value ? targetLabel(value) : !compact && emptyLabel}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={plain ? "left" : "bottom"}
        className="w-64 gap-3 rounded-xl p-3"
      >
        <label className="text-xs text-muted-foreground">
          Target date
          <Input
            aria-label="Set initiative target date"
            type="date"
            value={/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ""}
            onChange={(event) => {
              if (event.target.value) choose(event.target.value)
            }}
            className="mt-2 h-8 text-xs"
          />
        </label>
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
        <div className="grid grid-cols-4 gap-1">
          {[1, 2, 3, 4].map((quarter) => (
            <Button
              key={quarter}
              variant="secondary"
              size="sm"
              className="rounded-md text-xs"
              aria-pressed={value === `${selectedYear}-Q${quarter}`}
              onClick={() => choose(`${selectedYear}-Q${quarter}`)}
            >
              Q{quarter}
            </Button>
          ))}
        </div>
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
  const className = cn(
    initiativeChip,
    compact && directoryControlClassName,
    detail &&
      "h-7 max-w-full justify-start rounded-md border-0 bg-transparent px-1 text-[13px] font-normal hover:bg-muted/60"
  )
  const owner = people.find((person) => person.id === item.ownerId)
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
        <span className="truncate">
          {owner?.name ?? (!compact ? (detail ? "Add owner" : "Owner") : "")}
        </span>
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
