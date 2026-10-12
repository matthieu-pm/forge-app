import { format, formatDistanceToNowStrict } from "date-fns"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowRight01Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons"
import type { TeamLabel, TeamLabelGroup } from "@/lib/team-labels"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { TableCell, TableRow } from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function LabelGroupRow({
  group,
  labels,
  columns,
  rowClassName,
  expanded,
  selectedIds,
  onSelect,
  onToggle,
  onEdit,
  onCreate,
  onDelete,
}: {
  group: TeamLabelGroup
  labels: Array<TeamLabel>
  columns: {
    description: boolean
    rules?: boolean
    issues: boolean
    lastApplied: boolean
    created: boolean
  }
  rowClassName: string
  expanded: boolean
  selectedIds: Set<string>
  onSelect: (checked: boolean) => void
  onToggle: () => void
  onEdit: () => void
  onCreate: () => void
  onDelete: () => void
}) {
  const selected = labels.filter((label) => selectedIds.has(label.id)).length
  const issues =
    group.issues ?? labels.reduce((sum, label) => sum + label.issues, 0)
  const lastApplied = [
    group.lastApplied,
    ...labels.map((label) => label.lastApplied),
  ]
    .filter((date): date is string => !!date)
    .sort()
    .at(-1)
  const focus =
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
  return (
    <TableRow
      className={`${rowClassName} group/label cursor-pointer`}
      data-state={selected > 0 ? "selected" : undefined}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          !event.target.closest(
            "button, a, input, [role=checkbox], [role=menuitem]"
          )
        ) {
          onToggle()
        }
      }}
    >
      <TableCell className="p-0 sm:pl-2">
        <Checkbox
          aria-label={`Select labels in ${group.name}`}
          checked={selected > 0 && selected === labels.length}
          indeterminate={selected > 0 && selected < labels.length}
          disabled={!labels.length}
          onCheckedChange={onSelect}
          className={`size-3.5 rounded-[3px] border-muted-foreground/50 bg-transparent dark:bg-transparent ${selected ? "" : "opacity-0 group-focus-within/label:opacity-100 group-hover/label:opacity-100 max-sm:opacity-100"}`}
        />
      </TableCell>
      <TableCell className="relative px-0 py-0">
        <button
          type="button"
          aria-label={`${expanded ? "Collapse" : "Expand"} group ${group.name}`}
          aria-expanded={expanded}
          onClick={onToggle}
          className={`absolute top-1/2 -left-6 grid size-4 -translate-y-1/2 place-items-center rounded-sm text-muted-foreground hover:text-foreground ${focus}`}
        >
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            className={`size-3 ${expanded ? "rotate-90" : ""}`}
            strokeWidth={2}
          />
        </button>
        <button
          type="button"
          onClick={onToggle}
          aria-label={`Labels in ${group.name}`}
          aria-expanded={expanded}
          className={`flex min-h-11 max-w-full items-center gap-4 rounded-md pr-2 text-left text-sm ${focus}`}
        >
          <span
            aria-hidden="true"
            className="grid size-3 shrink-0 rotate-45 grid-cols-[3px_3px] grid-rows-[3px_3px] place-content-center gap-[2px]"
            style={{ color: group.color }}
          >
            {[0, 1, 2, 3].map((dot) => (
              <span key={dot} className="size-[3px] rounded-full bg-current" />
            ))}
          </span>
          <span className="truncate">{group.name}</span>
        </button>
      </TableCell>
      {columns.description && (
        <TableCell className="px-0 py-0 pr-5">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit description for ${group.name}`}
            className={`min-h-8 max-w-full truncate rounded-sm text-left text-sm text-muted-foreground ${group.description ? "" : "opacity-0 group-focus-within/label:opacity-100 group-hover/label:opacity-40"} ${focus}`}
          >
            {group.description || "Add label description..."}
          </button>
        </TableCell>
      )}
      {columns.rules && <TableCell className="px-0" />}
      {columns.issues && (
        <TableCell className="px-0 text-xs text-muted-foreground">
          {issues || ""}
        </TableCell>
      )}
      {columns.lastApplied && (
        <TableCell className="px-0 text-xs text-muted-foreground">
          {lastApplied
            ? `${formatDistanceToNowStrict(new Date(lastApplied), {
                roundingMethod: "floor",
              })
                .replace(/ months?$/, "mo")
                .replace(/ years?$/, "y")} ago`
            : ""}
        </TableCell>
      )}
      {columns.created && (
        <TableCell className="px-0 text-xs text-muted-foreground">
          {group.createdAt ? format(new Date(group.createdAt), "MMM yyyy") : ""}
        </TableCell>
      )}
      <TableCell className="p-0 pr-2 text-right">
        <DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            render={<DropdownMenuTrigger />}
            aria-label={`Actions for group ${group.name}`}
            className="size-7 rounded-md text-muted-foreground opacity-0 group-focus-within/label:opacity-100 group-hover/label:opacity-100 data-popup-open:opacity-100 max-sm:opacity-100"
          >
            <HugeiconsIcon
              icon={MoreHorizontalIcon}
              strokeWidth={1.5}
              className="size-4"
            />
          </Button>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>Edit group</DropdownMenuItem>
            <DropdownMenuItem onClick={onCreate}>
              New label in group
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              Delete group
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  )
}
