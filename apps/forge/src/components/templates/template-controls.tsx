import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  Building02Icon,
  Cancel01Icon,
  CubeIcon,
  File01Icon,
  Flag01Icon,
  Link01Icon,
  MoreHorizontalIcon,
  Tag01Icon,
  Tick02Icon,
  UserGroup03Icon,
} from "@hugeicons/core-free-icons"
import { Link } from "@tanstack/react-router"
import type { ReactNode } from "react"
import type {
  TemplateDirectory,
  TemplateProperties,
} from "@/lib/template-contract"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamLabelDirectory } from "@/lib/team-labels"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import {
  initialTeamLabels,
  parseTeamLabels,
  projectLabelsStorageKey,
  teamLabelsStorageKey,
  workspaceLabelsStorageKey,
} from "@/lib/team-labels"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

export const glyphs = {
  back: ArrowLeft01Icon,
  down: ArrowDown01Icon,
  more: MoreHorizontalIcon,
  label: Tag01Icon,
  person: UserGroup03Icon,
  project: CubeIcon,
  document: File01Icon,
  priority: Flag01Icon,
  dependency: Link01Icon,
  check: Tick02Icon,
  close: Cancel01Icon,
  add: Add01Icon,
  workspace: Building02Icon,
}
export function Glyph({
  name,
  className,
}: {
  name: keyof typeof glyphs
  className?: string
}) {
  return (
    <HugeiconsIcon
      icon={glyphs[name]}
      strokeWidth={1.8}
      className={cn("size-3.5 shrink-0", className)}
    />
  )
}
export function StatusIcon({ status }: { status: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border-[1.5px] text-[9px]",
        status === "Backlog"
          ? "border-dotted border-muted-foreground"
          : status === "In Progress"
            ? "border-yellow-400 text-yellow-400"
            : status === "In Review"
              ? "border-green-500 text-green-500"
              : ["Done", "Completed"].includes(status)
                ? "border-[#5e6ad2] bg-[#5e6ad2] text-white"
                : status === "Canceled"
                  ? "border-muted-foreground bg-muted-foreground text-background"
                  : "border-muted-foreground"
      )}
    >
      {["Done", "Completed"].includes(status)
        ? "✓"
        : status === "Canceled"
          ? "×"
          : ["In Progress", "In Review"].includes(status)
            ? "◐"
            : ""}
    </span>
  )
}
export function Action({
  children,
  onClick,
  label,
  shortcut,
}: {
  children: ReactNode
  onClick: () => void
  label?: string
  shortcut?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            aria-label={label}
            className="inline-flex h-7 items-center gap-1.5 rounded-full px-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="rounded-lg border border-border bg-popover text-foreground"
      >
        {label ?? children}
        {shortcut && <kbd className="text-muted-foreground">{shortcut}</kbd>}
      </TooltipContent>
    </Tooltip>
  )
}
export function TemplateShell({
  team,
  children,
  overview = false,
  section = "templates",
  workspace = false,
  workspaceKind = "issue",
}: {
  team?: TeamSummary
  children: ReactNode
  overview?: boolean
  workspace?: boolean
  workspaceKind?: "issue" | "project"
  section?: "templates" | "recurring-issues"
}) {
  return (
    <main className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center px-4">
        <Link
          to={
            workspace
              ? workspaceKind === "project"
                ? "/settings/project-templates"
                : "/settings/issue-templates"
              : overview
                ? "/settings/teams/$teamSlug"
                : section === "recurring-issues"
                  ? "/settings/teams/$teamSlug/recurring-issues"
                  : "/settings/teams/$teamSlug/templates"
          }
          params={{ teamSlug: team?.slug ?? "" }}
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <Glyph name="back" />
          {workspace ? (
            workspaceKind === "project" ? (
              "Project templates"
            ) : (
              "Issue templates"
            )
          ) : overview && team ? (
            <>
              <TeamSidebarIcon icon={team.icon} name={team.name} />
              {team.name}
            </>
          ) : section === "recurring-issues" ? (
            "Recurring issues"
          ) : (
            "Team templates"
          )}
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
        {children}
      </div>
    </main>
  )
}
export type Choice = {
  value: string
  label: string
  icon?: ReactNode
  group?: string
  detail?: string
}
export function Picker({
  label,
  placeholder,
  children,
  value,
  options,
  onChange,
  multiple = false,
  disabled = false,
  shortcut,
  empty = "No options available.",
  className,
}: {
  label: string
  placeholder?: string
  children: ReactNode
  value: string | Array<string> | null
  options: Array<Choice>
  onChange: (value: string | Array<string> | null) => void
  multiple?: boolean
  disabled?: boolean
  shortcut?: string
  empty?: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [active, setActive] = React.useState(0)
  const listRef = React.useRef<HTMLDivElement>(null)
  const selected = Array.isArray(value) ? value : value === null ? [] : [value]
  const filtered = options.filter((o) =>
    `${o.label} ${o.group ?? ""} ${o.detail ?? ""}`
      .toLowerCase()
      .includes(query.toLowerCase())
  )
  function choose(option: Choice) {
    if (multiple)
      onChange(
        selected.includes(option.value)
          ? selected.filter((v) => v !== option.value)
          : [...selected, option.value]
      )
    else {
      onChange(option.value || null)
      setOpen(false)
    }
  }
  React.useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" })
  }, [active])
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setQuery("")
        setActive(0)
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        aria-label={label}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50",
              selected.length > 0 && "text-foreground",
              className
            )}
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[252px] gap-0 rounded-xl p-1">
        <div className="flex items-center border-b border-border px-2">
          <Input
            aria-label={placeholder ?? label}
            placeholder={placeholder ?? label}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault()
                setActive(
                  (i) =>
                    (i +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      filtered.length) %
                    Math.max(1, filtered.length)
                )
              }
              if (event.key === "Enter" && filtered[active]) {
                event.preventDefault()
                choose(filtered[active])
              }
            }}
          />
          {shortcut && (
            <kbd className="shrink-0 text-[10px] text-muted-foreground">
              {shortcut}
            </kbd>
          )}
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-multiselectable={multiple || undefined}
          aria-label={label}
          className="max-h-80 overflow-y-auto py-1"
        >
          {filtered.map((option, index) => (
            <React.Fragment key={option.value}>
              {option.group && option.group !== filtered[index - 1]?.group && (
                <p className="px-2 pt-2 pb-1 text-[11px] text-muted-foreground">
                  {option.group}
                </p>
              )}
              <button
                type="button"
                role="option"
                aria-selected={
                  selected.includes(option.value) ||
                  (!option.value && !selected.length)
                }
                data-active={active === index}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(option)}
                className={cn(
                  "flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                  active === index && "bg-muted/60"
                )}
              >
                {multiple && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "grid size-3.5 place-items-center rounded-[3px] border border-border",
                      selected.includes(option.value) &&
                        "border-[#5e6ad2] bg-[#5e6ad2] text-white"
                    )}
                  >
                    {selected.includes(option.value) && (
                      <Glyph name="check" className="size-3" />
                    )}
                  </span>
                )}
                {option.icon}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.detail && (
                  <span className="text-muted-foreground">{option.detail}</span>
                )}
                {!multiple &&
                  (selected.includes(option.value) ||
                    (!option.value && !selected.length)) && (
                    <Glyph name="check" />
                  )}
              </button>
            </React.Fragment>
          ))}
          {!filtered.length && (
            <p className="p-3 text-xs text-muted-foreground">
              {query ? "No matching options." : empty}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
function personIcon(name: string, image: string | null) {
  return image ? (
    <img src={image} alt="" className="size-4 rounded-full object-cover" />
  ) : (
    <span
      aria-hidden
      className="grid size-4 place-items-center rounded-full bg-muted text-[8px]"
    >
      {name.slice(0, 1)}
    </span>
  )
}
export function useTemplateLabels(team?: TeamSummary, project = false) {
  const [directory, setDirectory] = React.useState<TeamLabelDirectory>(() => {
    const initial = initialTeamLabels(team?.slug ?? "")
    return project ? { ...initial, labels: [], groups: [] } : initial
  })
  React.useEffect(() => {
    function load() {
      const base = initialTeamLabels(team?.slug ?? "")
      let local = team && !project ? base : { ...base, labels: [], groups: [] }
      let workspace: TeamLabelDirectory = { ...base, labels: [], groups: [] }
      try {
        const saved =
          team && !project
            ? localStorage.getItem(teamLabelsStorageKey(team.id))
            : null
        if (saved) local = parseTeamLabels(saved)
        const shared = localStorage.getItem(
          project ? projectLabelsStorageKey : workspaceLabelsStorageKey
        )
        if (shared) workspace = parseTeamLabels(shared)
      } catch {
        /* Keep the valid initial directory. */
      }
      setDirectory({
        ...local,
        labels: [...local.labels, ...workspace.labels],
        groups: [...local.groups, ...workspace.groups],
      })
    }
    load()
    window.addEventListener("storage", load)
    return () => window.removeEventListener("storage", load)
  }, [team?.id, team?.slug, project])
  return directory.labels
    .filter((l) => !l.archived)
    .map((l) => ({
      value: l.id,
      label: l.name,
      group:
        directory.groups.find((g) => g.id === l.groupId)?.name ??
        (project ? "Project labels" : "Team labels"),
      icon: (
        <span
          aria-hidden
          className="size-2 rounded-full"
          style={{ backgroundColor: l.color }}
        />
      ),
    }))
}
export function Properties({
  value,
  onChange,
  directory,
  team,
  project = false,
  showTeam = true,
  workspace = false,
  children,
}: {
  value: TemplateProperties
  onChange: (value: TemplateProperties) => void
  directory: TemplateDirectory
  team?: TeamSummary
  project?: boolean
  showTeam?: boolean
  workspace?: boolean
  children?: ReactNode
}) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const sequence = React.useRef(0)
  React.useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const root = rootRef.current
      if (
        !root ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest('input, textarea, [contenteditable="true"]')) ||
        document.querySelector('[role="dialog"], [role="listbox"]')
      )
        return
      const groups = Array.from(
        document.querySelectorAll("[data-template-properties]")
      )
      if (groups.at(-1) !== root) return
      const key = event.key.toLowerCase()
      let label: string | undefined
      if (project) {
        if (sequence.current > Date.now()) {
          label = (
            {
              s: "Change status",
              p: "Change priority",
              t: "Change teams",
              l: "Add labels",
            } as Record<string, string>
          )[key]
          sequence.current = 0
        } else if (key === "p") {
          sequence.current = Date.now() + 1200
          event.preventDefault()
        }
      } else
        label = (
          {
            s: "Change status",
            p: "Change priority",
            a: "Assign to",
            l: "Add labels",
          } as Record<string, string>
        )[key]
      if (label) {
        event.preventDefault()
        root
          .querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
          ?.click()
      }
    }
    document.addEventListener("keydown", shortcut)
    return () => document.removeEventListener("keydown", shortcut)
  }, [project])
  const labels = useTemplateLabels(
    directory.teams.find((t) => t.id === value.teamIds[0]) ?? team,
    project
  )
  const patch = (
    key: keyof TemplateProperties,
    selected: string | Array<string> | null
  ) => onChange({ ...value, [key]: selected })
  const personChoices = directory.members.map((p) => ({
    value: p.id,
    label: p.name,
    icon: personIcon(p.name, p.image),
  }))
  const teamChoices = directory.teams.map((t) => ({
    value: t.id,
    label: t.name,
    detail: t.identifier,
    icon: <TeamSidebarIcon icon={t.icon} name={t.name} />,
  }))
  const statusChoices = (
    project
      ? ["Backlog", "To do", "In Progress", "Completed", "Canceled"]
      : ["Backlog", "Todo", "In Progress", "In Review", "Done", "Canceled"]
  ).map((status, i) => ({
    value: status,
    label: status,
    icon: <StatusIcon status={status} />,
    detail: String(i + 1),
  }))
  const priorities = ["No priority", "Urgent", "High", "Medium", "Low"].map(
    (p, i) => ({
      value: p,
      label: p,
      detail: String(i),
      icon: (
        <span aria-hidden className="w-3.5 text-center">
          {i === 0 ? "···" : i === 1 ? "!" : "▥"}
        </span>
      ),
    })
  )
  const selectedTeam =
    directory.teams.find((t) => t.id === value.teamIds[0]) ?? team
  const teamPicker = (
    <Picker
      label="Change teams"
      placeholder="Change teams..."
      shortcut={project ? "P then T" : undefined}
      multiple={project}
      value={project ? value.teamIds : value.teamIds[0]}
      options={
        workspace
          ? [{ value: "", label: "No team" }, ...teamChoices]
          : teamChoices
      }
      onChange={(selected) =>
        patch(
          "teamIds",
          Array.isArray(selected)
            ? selected.length
              ? selected
              : team
                ? [team.id]
                : []
            : selected
              ? [selected]
              : team
                ? [team.id]
                : []
        )
      }
    >
      {selectedTeam ? (
        <TeamSidebarIcon icon={selectedTeam.icon} name={selectedTeam.name} />
      ) : (
        <Glyph name="person" />
      )}
      {selectedTeam?.name ?? "Team"}
      {value.teamIds.length > 1 && ` +${value.teamIds.length - 1}`}
    </Picker>
  )
  return (
    <div
      ref={rootRef}
      data-template-properties
      className="flex flex-wrap items-center gap-1.5"
    >
      {!project && showTeam && teamPicker}
      {(!workspace || value.teamIds.length > 0) && (
        <Picker
          label="Change status"
          placeholder="Change status..."
          shortcut={project ? "P then S" : "S"}
          value={value.status}
          options={statusChoices}
          onChange={(selected) => patch("status", selected ?? "Backlog")}
        >
          <StatusIcon status={value.status} />
          {value.status}
        </Picker>
      )}
      <Picker
        label="Change priority"
        placeholder={project ? "Change priority..." : "Set priority to..."}
        shortcut={project ? "P then P" : "P"}
        value={value.priority}
        options={priorities}
        onChange={(selected) => patch("priority", selected ?? "No priority")}
      >
        <span aria-hidden>···</span>
        {value.priority === "No priority" && !project
          ? "Priority"
          : value.priority}
      </Picker>
      <Picker
        label={project ? "Set lead" : "Assign to"}
        shortcut={project ? undefined : "A"}
        placeholder={project ? "Set project lead..." : "Assign to..."}
        value={project ? value.lead : value.assignee}
        options={[
          {
            value: "",
            label: project ? "No lead" : "No assignee",
            icon: <Glyph name="person" />,
          },
          ...personChoices,
        ]}
        onChange={(selected) => patch(project ? "lead" : "assignee", selected)}
      >
        <Glyph name="person" />
        {directory.members.find(
          (p) => p.id === (project ? value.lead : value.assignee)
        )?.name ?? (project ? "Lead" : "Assignee")}
      </Picker>
      {project && (
        <>
          <Picker
            label="Project members"
            value={value.members}
            multiple
            options={personChoices}
            onChange={(selected) => patch("members", selected)}
          >
            <Glyph name="person" />
            {value.members.length
              ? `${value.members.length} member${value.members.length === 1 ? "" : "s"}`
              : "Members"}
          </Picker>
          {teamPicker}
          <Picker
            label="Initiatives"
            placeholder="Add initiatives..."
            multiple
            value={value.initiatives}
            options={[]}
            empty="No active initiatives in this workspace."
            onChange={(selected) => patch("initiatives", selected)}
          >
            <Glyph name="project" />
            Initiatives
          </Picker>
        </>
      )}
      {!project && (
        <Picker
          label="Set project"
          value={value.project}
          options={[
            { value: "", label: "No project", icon: <Glyph name="project" /> },
          ]}
          onChange={(selected) => patch("project", selected)}
        >
          <Glyph name="project" />
          {value.project ?? "Project"}
        </Picker>
      )}
      {workspace && (
        <Picker
          label="Change estimate"
          value={value.estimate ?? null}
          options={[
            { value: "", label: "No estimate" },
            ...["1", "2", "3", "5", "8", "13"].map((estimate) => ({
              value: estimate,
              label: estimate,
            })),
          ]}
          onChange={(selected) => patch("estimate", selected)}
        >
          <span aria-hidden>△</span>
          {value.estimate ?? "Estimate"}
        </Picker>
      )}
      <Picker
        label="Add labels"
        placeholder="Add labels..."
        shortcut={project ? "P then L" : "L"}
        multiple
        value={value.labels}
        options={labels}
        empty="No labels yet. Add labels in team settings."
        onChange={(selected) => patch("labels", selected)}
      >
        <Glyph name="label" />
        {value.labels.length
          ? `${value.labels.length} label${value.labels.length === 1 ? "" : "s"}`
          : "Labels"}
      </Picker>
      {project && <DependencyPicker value={value} onChange={onChange} />}
      {children}
    </div>
  )
}
function DependencyPicker({
  value,
  onChange,
}: {
  value: TemplateProperties
  onChange: (value: TemplateProperties) => void
}) {
  const [direction, setDirection] = React.useState<
    "blockedBy" | "blocking" | null
  >(null)
  return (
    <Popover onOpenChange={() => setDirection(null)}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 text-xs text-muted-foreground hover:bg-muted"
          />
        }
      >
        <Glyph name="dependency" />
        {value.dependencies.length
          ? `${value.dependencies.length} dependencies`
          : "Dependencies"}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 gap-1 rounded-xl p-1.5">
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {direction ? "Select project" : "Add dependency"}
        </p>
        {direction ? (
          <>
            <button
              type="button"
              onClick={() => setDirection(null)}
              className="p-2 text-left text-xs"
            >
              ‹ Back
            </button>
            <p className="p-2 text-xs text-muted-foreground">
              No projects in this workspace.
            </p>
          </>
        ) : (
          <>
            {(
              [
                ["blockedBy", "Blocked by..."],
                ["blocking", "Blocking..."],
              ] as const
            ).map(([key, text]) => (
              <button
                key={key}
                type="button"
                onClick={() => setDirection(key)}
                className="flex items-center justify-between rounded-lg p-2 text-left text-xs hover:bg-muted"
              >
                {text}
                <span>›</span>
              </button>
            ))}
            {value.dependencies.map((d, index) => (
              <button
                type="button"
                key={`${d.name}-${index}`}
                onClick={() =>
                  onChange({
                    ...value,
                    dependencies: value.dependencies.filter(
                      (_, i) => i !== index
                    ),
                  })
                }
                className="p-2 text-left text-xs hover:bg-muted"
              >
                {d.name} ×
              </button>
            ))}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}
export function SaveFooter({
  onCancel,
  onSave,
  saving,
  canSave = true,
  children,
  edit = false,
}: {
  onCancel: () => void
  onSave: () => void
  saving: boolean
  canSave?: boolean
  edit?: boolean
  children?: ReactNode
}) {
  return (
    <div className="mt-4 flex items-center justify-end gap-2 pb-10">
      {children}
      <Button
        type="button"
        variant="secondary"
        className="h-8 rounded-full border border-border/60 px-3 text-xs"
        onClick={onCancel}
        disabled={saving}
      >
        Cancel
      </Button>
      <Button
        type="button"
        className="h-8 rounded-full bg-[#5e6ad2] px-3 text-xs text-white hover:bg-[#5360c8]"
        onClick={onSave}
        disabled={saving || !canSave}
      >
        {saving ? "Saving…" : edit ? "Save changes" : "Create"}
      </Button>
    </div>
  )
}
