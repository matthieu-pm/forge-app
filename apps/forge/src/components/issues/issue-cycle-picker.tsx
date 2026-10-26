import { format, isValid, parseISO } from "date-fns"
import {
  IssueIcon,
  IssuePicker,
  issueChip,
  issuePropertyControl,
} from "./issue-controls"
import {
  scheduledTeamCycles,
  useEnabledTeamCycles,
  useTeamCycles,
} from "@/lib/team-cycles"
import { cn } from "@/lib/utils"

export function IssueCyclePicker({
  teamId,
  value,
  onChange,
  property = false,
}: {
  teamId: string
  value: string
  onChange: (cycle: string) => void
  property?: boolean
}) {
  const enabled = useEnabledTeamCycles([teamId]).has(teamId)
  const { settings, ready, error } = useTeamCycles(teamId)
  if (!enabled || !ready || error) return null
  const cycles = scheduledTeamCycles(settings)
  const selected = cycles.find((cycle) => cycle.value === value)
  const previous = parseISO(value)
  const previousLabel = isValid(previous)
    ? `Cycle · ${format(previous, "MMM d, yyyy")}`
    : "Assigned cycle"
  return (
    <IssuePicker
      label={value ? "Change cycle" : "Add to cycle"}
      shortcut="⇧ C"
      placeholder="Move to cycle…"
      value={value}
      options={[
        { value: "", label: "No cycle", icon: <IssueIcon name="clock" /> },
        ...(value && !selected
          ? [{ value, label: previousLabel, icon: <IssueIcon name="clock" /> }]
          : []),
        ...cycles.map((cycle) => ({
          value: cycle.value,
          label: `Cycle ${cycle.number} · ${cycle.number === 1 ? "Upcoming" : "Planned"} · ${format(cycle.start, "MMM d")}–${format(cycle.end, "MMM d")}`,
          icon: <IssueIcon name="clock" />,
        })),
      ]}
      onChange={onChange}
      className={cn(
        property ? issuePropertyControl : issueChip,
        value && "text-foreground"
      )}
    >
      <IssueIcon name="clock" />
      <span className="max-w-48 truncate">
        {selected
          ? `Cycle ${selected.number}`
          : value
            ? previousLabel
            : "Add to cycle"}
      </span>
    </IssuePicker>
  )
}
