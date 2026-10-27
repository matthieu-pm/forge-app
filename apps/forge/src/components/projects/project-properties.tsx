import type { ReactNode } from "react"
import type { InitiativePerson, InitiativeProject } from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import {
  projectStatusName,
  projectStatuses,
} from "@/components/initiatives/initiative-projects"
import { TargetPicker } from "@/components/initiatives/initiative-properties"
import {
  AssigneeMark,
  IssueIcon,
  IssuePicker,
  PriorityMark,
} from "@/components/issues/issue-controls"
import { IssueStatusIcon } from "@/components/issue-status-icon"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { initiativePriorities } from "@/lib/initiatives"
import { cn } from "@/lib/utils"
import { propertyButtonClassName } from "@/components/ui/button"

export function ProjectStatusMark({
  status,
}: {
  status: InitiativeProject["status"]
}) {
  return (
    <IssueStatusIcon
      group={
        status === "Backlog"
          ? "backlog"
          : status === "Active"
            ? "started"
            : status === "Completed"
              ? "completed"
              : status === "Canceled"
                ? "canceled"
                : "unstarted"
      }
      color={
        status === "Active"
          ? "#f2c94c"
          : status === "Completed"
            ? "#5e6ad2"
            : status === "Backlog"
              ? "#c98d45"
              : "#8a8f98"
      }
    />
  )
}
export function ProjectProperties({
  project,
  people,
  teams,
  disabled,
  expanded,
  onChange,
}: {
  project: InitiativeProject
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  disabled: boolean
  expanded?: boolean
  onChange: (patch: Partial<InitiativeProject>) => void
}) {
  const lead = people.find((p) => p.id === project.leadId)
  const projectTeams = teams.filter((team) => project.teamIds.includes(team.id))
  const split = (value: string) =>
    value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
  const style = cn(propertyButtonClassName, "text-foreground")
  const row = (label: string, control: ReactNode) =>
    expanded ? (
      <div className="grid w-full grid-cols-[76px_minmax(0,1fr)] items-center gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <div className="min-w-0">{control}</div>
      </div>
    ) : (
      control
    )
  return (
    <fieldset
      disabled={disabled}
      aria-label="Project properties"
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0",
        expanded && "flex-col items-start gap-2"
      )}
    >
      {row(
        "Status",
        <IssuePicker
          label="Change project status"
          side={expanded ? "left" : "bottom"}
          shortcut="P then S"
          value={project.status}
          options={projectStatuses.map((status) => ({
            value: status,
            label: projectStatusName(status),
            icon: <ProjectStatusMark status={status} />,
          }))}
          onChange={(status) =>
            onChange({ status: status as InitiativeProject["status"] })
          }
          className={style}
        >
          <ProjectStatusMark status={project.status} />
          {projectStatusName(project.status)}
        </IssuePicker>
      )}
      {row(
        "Priority",
        <IssuePicker
          label="Change project priority"
          side={expanded ? "left" : "bottom"}
          shortcut="P then P"
          value={project.priority ?? "No priority"}
          options={initiativePriorities.map((value) => ({
            value,
            label: value,
            icon: <PriorityMark priority={value} />,
          }))}
          onChange={(priority) =>
            onChange({ priority: priority as InitiativeProject["priority"] })
          }
          className={style}
        >
          <PriorityMark priority={project.priority ?? "No priority"} />
          {project.priority ?? "No priority"}
        </IssuePicker>
      )}
      {row(
        "Lead",
        <IssuePicker
          label="Set project lead"
          side={expanded ? "left" : "bottom"}
          shortcut="P then A"
          value={project.leadId ?? ""}
          options={[
            { value: "", label: "No lead" },
            ...people.map((p) => ({
              value: p.id,
              label: p.name,
              icon: <AssigneeMark name={p.name} image={p.image} />,
            })),
          ]}
          onChange={(leadId) => onChange({ leadId })}
          className={style}
        >
          <AssigneeMark name={lead?.name} image={lead?.image} />
          <span className="truncate">{lead?.name ?? "Lead"}</span>
        </IssuePicker>
      )}
      {expanded && (
        <>
          {row(
            "Members",
            <IssuePicker
              label="Change project members"
              multiple
              value={(project.memberIds ?? []).join(",")}
              options={people.map((p) => ({
                value: p.id,
                label: p.name,
                icon: <AssigneeMark name={p.name} image={p.image} />,
              }))}
              onChange={(value) => onChange({ memberIds: split(value) })}
              className={style}
            >
              <IssueIcon name="person" />
              Members
              {project.memberIds?.length
                ? ` (${project.memberIds.length})`
                : ""}
            </IssuePicker>
          )}
          {row(
            "Dates",
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <TargetPicker
                plain
                label="Change project start date"
                emptyLabel="Start"
                value={project.startDate ?? ""}
                onChange={(startDate) => onChange({ startDate })}
                disabled={disabled}
              />
              <span className="text-muted-foreground">→</span>
              <TargetPicker
                plain
                label="Change project target date"
                emptyLabel="Target"
                value={project.targetDate ?? ""}
                onChange={(targetDate) => onChange({ targetDate })}
                disabled={disabled}
              />
            </div>
          )}
        </>
      )}
      {!expanded && (
        <TargetPicker
          plain
          label="Change project target date"
          emptyLabel="Target date"
          value={project.targetDate ?? ""}
          onChange={(targetDate) => onChange({ targetDate })}
          disabled={disabled}
        />
      )}
      {row(
        "Teams",
        <IssuePicker
          label="Change project teams"
          side={expanded ? "left" : "bottom"}
          multiple
          value={project.teamIds.join(",")}
          options={teams.map((t) => ({
            value: t.id,
            label: t.name,
            icon: <TeamSidebarIcon name={t.name} icon={t.icon} />,
          }))}
          onChange={(value) => onChange({ teamIds: split(value) })}
          className={style}
        >
          {projectTeams[0] ? (
            <TeamSidebarIcon
              name={projectTeams[0].name}
              icon={projectTeams[0].icon}
            />
          ) : (
            <IssueIcon name="layers" />
          )}
          <span className="truncate">
            {projectTeams.map((t) => t.name).join(", ") || "Teams"}
          </span>
        </IssuePicker>
      )}
    </fieldset>
  )
}
