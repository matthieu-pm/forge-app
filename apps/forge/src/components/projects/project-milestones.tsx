import { useEffect, useRef, useState } from "react"
import { format, isValid, parseISO } from "date-fns"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import { PencilEdit02Icon } from "@hugeicons/core-free-icons"
import type { IssueQueryPage } from "@/lib/issue-query-contract"
import type { InitiativeProject } from "@/lib/initiatives"
import type { MilestoneIssue, ProjectMilestone } from "@/lib/project-milestones"
import {
  NO_MILESTONE,
  currentProjectMilestone,
  milestoneDateLabel,
  milestoneProgress,
} from "@/lib/project-milestones"
import {
  DetailDescription,
  DetailTitle,
} from "@/components/issues/detail-content"
import { IssueIcon } from "@/components/issues/issue-controls"
import { MilestoneMark } from "@/components/ui/milestone-mark"
import { Button, propertyButtonClassName } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

function MilestoneDatePicker({
  milestone,
  onChange,
  writable,
  inline = false,
}: {
  inline?: boolean
  milestone: ProjectMilestone
  onChange: (value: string) => void
  writable: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = milestone.targetDate
    ? parseISO(milestone.targetDate)
    : undefined
  const choose = (value: string) => {
    onChange(value)
    setOpen(false)
  }
  const content = (
    <>
      <Input
        type="date"
        aria-label={`${milestone.name} target date`}
        value={milestone.targetDate?.length === 10 ? milestone.targetDate : ""}
        onChange={(event) => choose(event.target.value)}
      />
      <Calendar
        mode="single"
        selected={selected && isValid(selected) ? selected : undefined}
        defaultMonth={selected && isValid(selected) ? selected : undefined}
        onSelect={(date) => {
          if (date) choose(format(date, "yyyy-MM-dd"))
        }}
      />
      {milestone.targetDate && (
        <Button variant="ghost" size="sm" onClick={() => choose("")}>
          Clear target date
        </Button>
      )}
    </>
  )
  if (inline) return content
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            disabled={!writable}
            aria-label={`Change target date for ${milestone.name}`}
            className={cn(propertyButtonClassName, "h-6 px-1 text-xs")}
          />
        }
      >
        {milestoneDateLabel(milestone.targetDate)}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto gap-2 p-2">
        {content}
      </PopoverContent>
    </Popover>
  )
}

export type MilestoneControls = {
  project: InitiativeProject
  catalog: Array<InitiativeProject>
  canRelocate?: boolean
  counts?: IssueQueryPage["rollups"]
  rows: Array<MilestoneIssue>
  writable: boolean
  selected?: string
  onChange: (milestone: ProjectMilestone) => boolean
  onEdit: (id: string) => void
  onIssues: (id?: string) => void
  onReorder?: (milestones: Array<ProjectMilestone>) => void
  onRelocate: (id: string, targetId?: string, convert?: boolean) => boolean
}

function MilestoneActions({
  milestone,
  ...props
}: MilestoneControls & { milestone: ProjectMilestone }) {
  const [history, setHistory] = useState(false)
  const [dateOpen, setDateOpen] = useState(false)
  async function copy(kind: "link" | "name" | "markdown") {
    const url = new URL(`/projects/${props.project.id}`, window.location.origin)
    url.searchParams.set("tab", "overview")
    url.hash = `milestone-${milestone.id}`
    try {
      await navigator.clipboard.writeText(
        kind === "name"
          ? milestone.name
          : kind === "markdown"
            ? `[${milestone.name}](${url})`
            : url.toString()
      )
      toast.success("Copied milestone")
    } catch {
      toast.error("The milestone could not be copied")
    }
  }
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Actions for ${milestone.name}`}
              className="shrink-0 text-muted-foreground"
            />
          }
        >
          <IssueIcon name="more" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            disabled={!props.writable}
            onClick={() => props.onEdit(milestone.id)}
          >
            <HugeiconsIcon icon={PencilEdit02Icon} className="size-3.5" />
            Edit…
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!props.writable}
            onClick={() => setDateOpen(true)}
          >
            <IssueIcon name="date" />
            Edit target date…{" "}
            <span className="ml-auto text-xs text-muted-foreground">
              {milestone.targetDate && milestoneDateLabel(milestone.targetDate)}
            </span>
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <IssueIcon name="copy" />
              Copy
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={() => void copy("link")}>
                Copy link
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void copy("name")}>
                Copy name
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void copy("markdown")}>
                Copy as Markdown
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onClick={() => setHistory(true)}>
            <IssueIcon name="clock" />
            Show description history
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!props.writable}
            onClick={() =>
              props.onChange({ ...milestone, completed: !milestone.completed })
            }
          >
            <IssueIcon name="check" />
            {milestone.completed ? "Mark incomplete" : "Mark complete"}
          </DropdownMenuItem>
          {[-1, 1].map((offset) => {
            const milestones = props.project.milestones ?? [],
              index = milestones.findIndex((item) => item.id === milestone.id)
            return (
              <DropdownMenuItem
                key={offset}
                disabled={
                  !props.writable ||
                  index + offset < 0 ||
                  index + offset >= milestones.length
                }
                onClick={() => {
                  const next = [...milestones]
                  next.splice(index + offset, 0, ...next.splice(index, 1))
                  props.onReorder?.(next)
                }}
              >
                <IssueIcon name={offset < 0 ? "up" : "down"} />
                {offset < 0 ? "Move earlier" : "Move later"}
              </DropdownMenuItem>
            )
          })}
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              disabled={!props.writable || props.canRelocate === false}
            >
              <MilestoneMark />
              Move milestone to
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {props.catalog
                .filter((project) => project.id !== props.project.id)
                .map((project) => (
                  <DropdownMenuItem
                    key={project.id}
                    onClick={() => props.onRelocate(milestone.id, project.id)}
                  >
                    {project.name}
                  </DropdownMenuItem>
                ))}
              {props.catalog.length < 2 && (
                <DropdownMenuItem disabled>No other projects</DropdownMenuItem>
              )}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            disabled={!props.writable || props.canRelocate === false}
            onClick={() => props.onRelocate(milestone.id, undefined, true)}
          >
            <IssueIcon name="project" />
            Convert to project
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={!props.writable || props.canRelocate === false}
            variant="destructive"
            onClick={() => props.onRelocate(milestone.id)}
          >
            <IssueIcon name="delete" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={dateOpen} onOpenChange={setDateOpen}>
        <DialogContent className="max-w-sm">
          <DialogTitle>{milestone.name} target date</DialogTitle>
          <MilestoneDatePicker
            milestone={milestone}
            writable={props.writable}
            inline
            onChange={(targetDate) => {
              if (props.onChange({ ...milestone, targetDate }))
                setDateOpen(false)
            }}
          />
        </DialogContent>
      </Dialog>
      <Dialog open={history} onOpenChange={setHistory}>
        <DialogContent>
          <DialogTitle>{milestone.name} description history</DialogTitle>
          {milestone.descriptionHistory?.length ? (
            <div className="max-h-96 space-y-5 overflow-y-auto">
              {[...milestone.descriptionHistory]
                .reverse()
                .map((entry, index) => (
                  <section key={`${entry.createdAt}-${index}`}>
                    <p className="mb-2 text-xs text-muted-foreground">
                      {format(new Date(entry.createdAt), "MMM d, yyyy · HH:mm")}
                    </p>
                    <DetailDescription
                      value=""
                      document={entry.description}
                      label={`Description version ${index + 1}`}
                      editable={false}
                      onSave={() => false}
                    />
                  </section>
                ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No previous descriptions yet.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

export function ProjectMilestoneSummary(props: MilestoneControls) {
  const [dragged, setDragged] = useState<string>()
  const milestones = props.project.milestones ?? []
  const current = currentProjectMilestone(
    props.project,
    props.rows,
    props.counts
  )
  function reorder(target: string) {
    if (!dragged || dragged === target) return
    const next = [...milestones]
    const from = next.findIndex((m) => m.id === dragged),
      to = next.findIndex((m) => m.id === target)
    if (from < 0 || to < 0) return
    next.splice(to, 0, ...next.splice(from, 1))
    props.onReorder?.(next)
    setDragged(undefined)
  }
  return (
    <div className="space-y-1">
      {milestones.map((milestone) => {
        const progress = milestoneProgress(milestone, props.rows, props.counts)
        return (
          <div
            key={milestone.id}
            draggable={props.writable}
            onDragStart={() => setDragged(milestone.id)}
            onDragEnd={() => setDragged(undefined)}
            onDragOver={(event) => {
              if (dragged) event.preventDefault()
            }}
            onDrop={(event) => {
              event.preventDefault()
              reorder(milestone.id)
            }}
            className={cn(
              "group/milestone flex min-h-8 items-center gap-1 rounded-lg px-1 focus-within:bg-muted/60 hover:bg-muted/60",
              props.selected === milestone.id && "bg-muted/60"
            )}
          >
            <button
              type="button"
              onClick={() =>
                props.onIssues(
                  props.selected === milestone.id ? undefined : milestone.id
                )
              }
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MilestoneMark active={current?.id === milestone.id} />
              <span className="truncate">{milestone.name}</span>
              <span className="shrink-0 text-muted-foreground">
                {progress.percent}% of {progress.count}
              </span>
            </button>
            <button
              type="button"
              onClick={() =>
                props.onIssues(
                  props.selected === milestone.id ? undefined : milestone.id
                )
              }
              className={cn(
                "shrink-0 text-[10px] text-muted-foreground hover:text-foreground",
                props.selected === milestone.id
                  ? ""
                  : "opacity-0 group-focus-within/milestone:opacity-100 group-hover/milestone:opacity-100"
              )}
            >
              {props.selected === milestone.id ? "Clear filter" : "See issues"}
            </button>
            {milestone.targetDate && (
              <MilestoneDatePicker
                milestone={milestone}
                writable={props.writable}
                onChange={(targetDate) =>
                  props.onChange({ ...milestone, targetDate })
                }
              />
            )}
            <MilestoneActions {...props} milestone={milestone} />
          </div>
        )
      })}
      {milestones.length ? (
        <button
          type="button"
          onClick={() =>
            props.onIssues(
              props.selected === NO_MILESTONE ? undefined : NO_MILESTONE
            )
          }
          className={cn(
            "flex h-8 w-full items-center gap-1.5 rounded-lg px-1 text-left text-xs text-muted-foreground hover:bg-muted/60",
            props.selected === NO_MILESTONE && "bg-muted/60"
          )}
        >
          <MilestoneMark />
          No milestone
          {props.selected === NO_MILESTONE && (
            <span className="ml-auto text-[10px]">Clear filter</span>
          )}
        </button>
      ) : (
        <p className="text-xs leading-relaxed text-muted-foreground/70">
          Add milestones to organize work within your project and break it into
          more granular stages.
        </p>
      )}
    </div>
  )
}

type OverviewProps = MilestoneControls & {
  adding: boolean
  onAddingChange: (value: boolean) => void
  onAdd: (name: string) => boolean
  editingId?: { id: string; request: number }
  onReorder?: (milestones: Array<ProjectMilestone>) => void
}

export function ProjectMilestones(props: OverviewProps) {
  const [collapsed, setCollapsed] = useState<Array<string>>([])
  const [name, setName] = useState("")
  const [dragged, setDragged] = useState<string>()
  const root = useRef<HTMLElement>(null)
  const milestones = props.project.milestones ?? []
  const current = currentProjectMilestone(
    props.project,
    props.rows,
    props.counts
  )
  useEffect(() => {
    if (props.editingId) {
      const element = root.current?.querySelector<HTMLInputElement>(
        `[data-milestone-id="${props.editingId.id}"] input`
      )
      element?.focus()
      element?.select()
      if (typeof element?.scrollIntoView === "function")
        element.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }, [props.editingId])
  return (
    <section
      ref={root}
      className="mt-10 space-y-2"
      aria-label="Milestones"
      id="project-milestones"
    >
      {!!milestones.length && (
        <h2 className="mb-3 text-xs font-normal text-muted-foreground">
          Milestones
        </h2>
      )}
      {milestones.map((milestone) => {
        const progress = milestoneProgress(milestone, props.rows, props.counts),
          expanded = !collapsed.includes(milestone.id)
        return (
          <Collapsible
            key={milestone.id}
            open={expanded}
            onOpenChange={(open) =>
              setCollapsed((ids) =>
                open
                  ? ids.filter((id) => id !== milestone.id)
                  : [...ids, milestone.id]
              )
            }
            id={`milestone-${milestone.id}`}
            data-milestone-id={milestone.id}
            draggable={props.writable}
            onDragStart={() => setDragged(milestone.id)}
            onDragEnd={() => setDragged(undefined)}
            onDragOver={(event) => {
              if (dragged) event.preventDefault()
            }}
            onDrop={(event) => {
              event.preventDefault()
              if (!dragged || dragged === milestone.id) return
              const next = [...milestones]
              const from = next.findIndex((item) => item.id === dragged)
              const to = next.findIndex((item) => item.id === milestone.id)
              if (from >= 0 && to >= 0) {
                next.splice(to, 0, ...next.splice(from, 1))
                props.onReorder?.(next)
              }
              setDragged(undefined)
            }}
            className="group/milestone scroll-mt-6 rounded-lg"
          >
            <div className="flex min-h-9 items-center gap-1 rounded-lg px-1 focus-within:bg-muted/50 hover:bg-muted/50">
              <MilestoneMark active={current?.id === milestone.id} />
              <DetailTitle
                value={milestone.name}
                label={`Milestone name for ${milestone.name}`}
                editable={props.writable}
                onSave={(next) =>
                  props.onChange({
                    ...milestone,
                    name: next,
                    aliases: [
                      ...new Set([
                        ...(milestone.aliases ?? []),
                        milestone.name,
                      ]),
                    ],
                  })
                }
                className="mb-0 [field-sizing:content] w-auto max-w-[45%] min-w-12 text-[13px] font-medium"
              />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`${expanded ? "Collapse" : "Expand"} ${milestone.name}`}
                aria-expanded={expanded}
                onClick={() =>
                  setCollapsed((ids) =>
                    expanded
                      ? [...ids, milestone.id]
                      : ids.filter((id) => id !== milestone.id)
                  )
                }
              >
                <IssueIcon
                  name="down"
                  className={cn(
                    "size-3 transition-transform duration-150 motion-reduce:transition-none",
                    !expanded && "-rotate-90"
                  )}
                />
              </Button>
              <div className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                <MilestoneDatePicker
                  milestone={milestone}
                  writable={props.writable}
                  onChange={(targetDate) =>
                    props.onChange({ ...milestone, targetDate })
                  }
                />
                <button
                  type="button"
                  onClick={() => props.onIssues(milestone.id)}
                  className="rounded px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`View issues for ${milestone.name}`}
                >
                  {progress.count} {progress.count === 1 ? "issue" : "issues"} ·{" "}
                  {progress.percent}%
                </button>
                <span className="opacity-0 group-focus-within/milestone:opacity-100 group-hover/milestone:opacity-100">
                  <MilestoneActions {...props} milestone={milestone} />
                </span>
              </div>
            </div>
            <CollapsibleContent
              keepMounted
              className="h-(--collapsible-panel-height) overflow-hidden opacity-100 transition-[height,opacity] duration-200 ease-out data-ending-style:h-0 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:opacity-0 motion-reduce:transition-none"
            >
              <div className="px-3 pt-3 pb-6">
                <DetailDescription
                  value=""
                  document={milestone.description}
                  label={`Description for ${milestone.name}`}
                  editable={props.writable}
                  onSave={(_text, description) =>
                    props.onChange({
                      ...milestone,
                      description,
                      descriptionHistory: [
                        ...(milestone.descriptionHistory ?? []),
                        {
                          description: milestone.description ?? null,
                          createdAt: new Date().toISOString(),
                        },
                      ],
                    })
                  }
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        )
      })}
      {props.adding && (
        <form
          className="flex items-center gap-2 rounded-lg bg-muted/40 p-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (name.trim() && props.onAdd(name.trim())) {
              setName("")
              props.onAddingChange(false)
            }
          }}
        >
          <MilestoneMark />
          <Input
            autoFocus
            aria-label="Milestone name"
            placeholder="Milestone name"
            maxLength={200}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                setName("")
                props.onAddingChange(false)
              }
            }}
            className="h-7 border-0 bg-transparent shadow-none"
          />
          <Button size="sm" type="submit" disabled={!name.trim()}>
            Add milestone
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            type="button"
            aria-label="Cancel new milestone"
            onClick={() => props.onAddingChange(false)}
          >
            <IssueIcon name="close" />
          </Button>
        </form>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="px-1 text-muted-foreground"
        disabled={!props.writable || props.adding}
        onClick={() => props.onAddingChange(true)}
      >
        <IssueIcon name="add" />
        Milestone
      </Button>
    </section>
  )
}
