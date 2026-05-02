import * as React from "react"
import { useParams } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AttachmentIcon,
  Calendar03Icon,
  CancelCircleIcon,
  Edit02Icon,
  FilterHorizontalIcon,
  Link04Icon,
  PlusSignIcon,
  ProgressIcon,
  Rocket01Icon,
  SlidersHorizontalIcon,
  StarIcon,
  ChartUpIcon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"
import {
  formatTargetDate,
  getOwner,
  getProjects,
  isPastDate,
  MOCK_OWNERS,
  type Initiative,
  type InitiativeOwner,
  type InitiativeStatus,
  type Project,
} from "@/lib/initiatives-data"
import { updateInitiative, useInitiative } from "@/lib/initiatives-store"

const STATUS_LABEL: Record<InitiativeStatus, string> = {
  active: "Active",
  planned: "Planned",
  completed: "Completed",
}

const STATUS_DOT: Record<InitiativeStatus, string> = {
  active: "bg-amber-500",
  planned: "bg-sky-500",
  completed: "bg-emerald-500",
}

export function InitiativeDetailPage() {
  const { initiativeId } = useParams({
    from: "/workspace/initiatives/$initiativeId",
  })
  const initiative = useInitiative(initiativeId)
  const [tab, setTab] = React.useState<"overview" | "activity" | "projects">(
    "overview"
  )

  if (!initiative) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-sm text-muted-foreground">
          Initiative not found.
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      <DetailHeader initiative={initiative} />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          setTab(value as "overview" | "activity" | "projects")
        }
        className="flex flex-1 flex-col"
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
          <TabsList
            aria-label="Initiative sections"
            className="h-auto items-center gap-1 bg-transparent p-0"
          >
            {(["overview", "activity", "projects"] as const).map((value) => (
              <TabsTrigger
                key={value}
                value={value}
                className={cn(
                  "h-7 flex-none rounded-full border border-transparent bg-transparent px-3 py-0.5 text-sm text-muted-foreground hover:text-foreground after:hidden",
                  "data-active:border-transparent data-active:bg-muted data-active:font-medium data-active:text-foreground"
                )}
              >
                {value === "overview"
                  ? "Overview"
                  : value === "activity"
                    ? "Activity"
                    : "Projects"}
              </TabsTrigger>
            ))}
          </TabsList>
          {tab === "projects" ? (
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Filter"
                className="text-muted-foreground hover:text-foreground"
              >
                <HugeiconsIcon icon={FilterHorizontalIcon} strokeWidth={2} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Display options"
                className="text-muted-foreground hover:text-foreground"
              >
                <HugeiconsIcon icon={SlidersHorizontalIcon} strokeWidth={2} />
              </Button>
            </div>
          ) : null}
        </div>
        <TabsContent value="overview" className="flex-1">
          <OverviewTab initiative={initiative} />
        </TabsContent>
        <TabsContent value="activity" className="flex-1">
          <ActivityTab initiative={initiative} />
        </TabsContent>
        <TabsContent value="projects" className="flex-1">
          <ProjectsTimelineTab initiative={initiative} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function DetailHeader({ initiative }: { initiative: Initiative }) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <span
          className={cn(
            "flex size-5 items-center justify-center rounded-full text-white",
            initiative.accentColor
          )}
        >
          <HugeiconsIcon
            icon={Rocket01Icon}
            strokeWidth={2}
            className="size-3"
          />
        </span>
        <span>{initiative.name}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Star"
          className="text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={StarIcon} strokeWidth={2} />
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Copy link"
          className="text-muted-foreground hover:text-foreground"
        >
          <HugeiconsIcon icon={Link04Icon} strokeWidth={2} />
        </Button>
      </div>
    </div>
  )
}

function OverviewTab({ initiative }: { initiative: Initiative }) {
  const owner = getOwner(initiative.ownerId)
  const projects = getProjects(initiative.projectIds)
  const targetLabel = formatTargetDate(initiative.targetDate)
  const overdue = isPastDate(initiative.targetDate)
  const [description, setDescription] = React.useState("")

  return (
    <div className="flex flex-col gap-10 px-4 py-10">
      <section className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <div className="flex flex-col gap-3">
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-full text-white",
              initiative.accentColor
            )}
          >
            <HugeiconsIcon
              icon={Rocket01Icon}
              strokeWidth={2}
              className="size-4"
            />
          </span>
          <h1 className="text-2xl font-semibold">{initiative.name}</h1>
          {initiative.description ? (
            <p className="text-sm text-muted-foreground">
              {initiative.description}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 text-sm">
          <PropertyRow label="Properties">
            <StatusPopover
              status={initiative.status}
              onChange={(s) => updateInitiative(initiative.id, { status: s })}
            />
            <OwnerPopover
              ownerId={initiative.ownerId}
              onChange={(id) =>
                updateInitiative(initiative.id, { ownerId: id })
              }
              trigger={
                <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
                  {owner ? (
                    <>
                      <Avatar size="sm" className="size-4">
                        <AvatarFallback
                          className={cn("text-[9px]", owner.color)}
                        >
                          {owner.initials}
                        </AvatarFallback>
                      </Avatar>
                      <span>{owner.name}</span>
                    </>
                  ) : (
                    <>
                      <HugeiconsIcon
                        icon={UserCircleIcon}
                        strokeWidth={2}
                        className="size-4"
                      />
                      <span>Unassigned</span>
                    </>
                  )}
                </Button>
              }
            />
            <TargetDatePopover
              targetDate={initiative.targetDate}
              onChange={(iso) =>
                updateInitiative(initiative.id, { targetDate: iso })
              }
              trigger={
                <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
                  <HugeiconsIcon
                    icon={Calendar03Icon}
                    strokeWidth={2}
                    className={cn("size-3.5", overdue && "text-rose-500")}
                  />
                  <span className={cn(overdue && "text-rose-500")}>
                    {targetLabel || "Set target date"}
                  </span>
                </Button>
              }
            />
          </PropertyRow>
          <PropertyRow label="Resources">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            >
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
              Add document or link...
            </Button>
          </PropertyRow>
        </div>
        <button
          type="button"
          className="flex w-full items-center justify-center gap-2 border bg-muted/30 px-4 py-3 text-sm text-muted-foreground hover:bg-muted/50"
        >
          <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} className="size-4" />
          Write first initiative update
        </button>
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Description</h2>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add description..."
            className="min-h-24 resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
          />
        </div>
      </section>
      <section className="flex flex-col">
        <div className="flex items-center justify-between border-b pb-2">
          <h2 className="text-sm font-medium">Projects</h2>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Display options"
              className="text-muted-foreground hover:text-foreground"
            >
              <HugeiconsIcon icon={SlidersHorizontalIcon} strokeWidth={2} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Add project"
              className="text-muted-foreground hover:text-foreground"
            >
              <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
            </Button>
          </div>
        </div>
        <ProjectsTable projects={projects} owner={owner} />
      </section>
    </div>
  )
}

function PropertyRow({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  )
}

function StatusPopover({
  status,
  onChange,
}: {
  status: InitiativeStatus
  onChange: (status: InitiativeStatus) => void
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
            <span
              className={cn("inline-block size-2 rounded-full", STATUS_DOT[status])}
            />
            <span>{STATUS_LABEL[status]}</span>
          </Button>
        }
      />
      <PopoverContent className="w-44 p-0" align="start">
        <Command>
          <CommandList>
            <CommandGroup>
              {(["active", "planned", "completed"] as const).map((s) => (
                <CommandItem
                  key={s}
                  value={s}
                  data-checked={status === s}
                  onSelect={() => {
                    onChange(s)
                    setOpen(false)
                  }}
                >
                  <span
                    className={cn(
                      "inline-block size-2 rounded-full",
                      STATUS_DOT[s]
                    )}
                  />
                  {STATUS_LABEL[s]}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function OwnerPopover({
  ownerId,
  onChange,
  trigger,
}: {
  ownerId: string | null
  onChange: (id: string | null) => void
  trigger: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Set owner..." />
          <CommandList>
            <CommandEmpty>No people found.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__unassigned"
                data-checked={ownerId === null}
                onSelect={() => {
                  onChange(null)
                  setOpen(false)
                }}
              >
                <HugeiconsIcon
                  icon={CancelCircleIcon}
                  strokeWidth={2}
                  className="size-4"
                />
                Unassigned
              </CommandItem>
              {MOCK_OWNERS.map((o: InitiativeOwner) => (
                <CommandItem
                  key={o.id}
                  value={o.name}
                  data-checked={ownerId === o.id}
                  onSelect={() => {
                    onChange(o.id)
                    setOpen(false)
                  }}
                >
                  <Avatar size="sm" className="size-4">
                    <AvatarFallback className={cn("text-[9px]", o.color)}>
                      {o.initials}
                    </AvatarFallback>
                  </Avatar>
                  <span>{o.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function TargetDatePopover({
  targetDate,
  onChange,
  trigger,
}: {
  targetDate: string | null
  onChange: (iso: string | null) => void
  trigger: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const selected = targetDate ? new Date(targetDate + "T00:00:00") : undefined
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={selected}
          onSelect={(date) => {
            if (!date) {
              onChange(null)
            } else {
              const y = date.getFullYear()
              const m = String(date.getMonth() + 1).padStart(2, "0")
              const d = String(date.getDate()).padStart(2, "0")
              onChange(`${y}-${m}-${d}`)
            }
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

function ProjectsTable({
  projects,
  owner,
}: {
  projects: Array<Project>
  owner: InitiativeOwner | null
}) {
  if (projects.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
        No projects associated yet.
      </div>
    )
  }
  return (
    <div className="flex flex-col">
      <div className="grid h-9 items-center gap-3 border-b px-1 text-xs text-muted-foreground [grid-template-columns:1fr_120px_90px_60px_120px_90px]">
        <div>Name</div>
        <div>Health</div>
        <div>Priority</div>
        <div>Lead</div>
        <div>Target date</div>
        <div>Status</div>
      </div>
      <div className="flex h-7 items-center gap-2 px-1 text-xs text-muted-foreground">
        <span>Backlog</span>
      </div>
      {projects.map((project) => (
        <div
          key={project.id}
          className="grid items-center gap-3 border-b px-1 py-2 text-sm hover:bg-muted/40 [grid-template-columns:1fr_120px_90px_60px_120px_90px]"
        >
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "flex size-4 items-center justify-center rounded-full border",
                project.completed
                  ? "border-emerald-500 bg-emerald-500"
                  : "border-muted-foreground/40"
              )}
            />
            <span className="truncate">{project.name}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="inline-block size-2 rounded-full border border-dashed border-muted-foreground/60" />
            No updates
          </div>
          <div className="text-xs text-muted-foreground">—</div>
          <div className="flex items-center">
            {owner ? (
              <Avatar size="sm" className="size-4">
                <AvatarFallback className={cn("text-[9px]", owner.color)}>
                  {owner.initials}
                </AvatarFallback>
              </Avatar>
            ) : (
              <HugeiconsIcon
                icon={UserCircleIcon}
                strokeWidth={2}
                className="size-4 text-muted-foreground"
              />
            )}
          </div>
          <div className="text-xs text-muted-foreground">—</div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <HugeiconsIcon
              icon={ProgressIcon}
              strokeWidth={2}
              className="size-3.5"
            />
            <span>{project.completed ? "100%" : "0%"}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function ActivityTab({ initiative }: { initiative: Initiative }) {
  const [mode, setMode] = React.useState<"comment" | "update">("update")
  const [body, setBody] = React.useState("")
  const owner = getOwner(initiative.ownerId)

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8">
      <div className="flex flex-col border bg-muted/20">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <button
            type="button"
            onClick={() => setMode("comment")}
            className={cn(
              "rounded-full px-2 py-0.5 text-xs",
              mode === "comment"
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Comment
          </button>
          <button
            type="button"
            onClick={() => setMode("update")}
            className={cn(
              "rounded-full px-2 py-0.5 text-xs",
              mode === "update"
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            Update
          </button>
          {mode === "update" ? (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600">
              <HugeiconsIcon
                icon={ChartUpIcon}
                strokeWidth={2}
                className="size-3"
              />
              On track
            </span>
          ) : null}
        </div>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            mode === "update"
              ? "Write an initiative update..."
              : "Leave a comment..."
          }
          className="min-h-24 resize-none border-0 bg-transparent p-3 text-sm shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between border-t px-3 py-2">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Attach"
            className="text-muted-foreground hover:text-foreground"
          >
            <HugeiconsIcon icon={AttachmentIcon} strokeWidth={2} />
          </Button>
          <Button size="sm" disabled={body.trim().length === 0}>
            {mode === "update" ? "Post update" : "Comment"}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-base font-medium">
          {monthName(initiative.targetDate)}
        </h3>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span
            className={cn(
              "flex size-5 items-center justify-center rounded-full text-white",
              initiative.accentColor
            )}
          >
            <HugeiconsIcon
              icon={Rocket01Icon}
              strokeWidth={2}
              className="size-3"
            />
          </span>
          <span>
            {owner ? owner.name : "someone"} created the initiative
          </span>
          <span>·</span>
          <span>{currentMonthDay()}</span>
        </div>
      </div>
    </div>
  )
}

function ProjectsTimelineTab({ initiative }: { initiative: Initiative }) {
  const projects = getProjects(initiative.projectIds)
  const owner = getOwner(initiative.ownerId)
  const months = React.useMemo(() => buildMonthRange(), [])
  const todayIndex = months.findIndex((m) => m.isCurrent)

  if (projects.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        No projects in this initiative.
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="relative grid border-b text-xs text-muted-foreground [grid-template-columns:240px_1fr]">
        <div className="border-r" />
        <div
          className="grid"
          style={{ gridTemplateColumns: `repeat(${months.length}, 1fr)` }}
        >
          {months.map((m) => (
            <div
              key={m.key}
              className={cn(
                "flex flex-col items-center gap-0.5 border-l py-1.5 uppercase",
                m.isCurrent && "text-foreground"
              )}
            >
              <span>{m.label}</span>
              <span className="text-[10px]">{m.dayLabel}</span>
            </div>
          ))}
        </div>
      </div>
      {projects.map((project, idx) => (
        <div
          key={project.id}
          className="grid items-center border-b text-sm [grid-template-columns:240px_1fr]"
        >
          <div className="flex items-center gap-2 border-r px-3 py-2.5">
            <span
              className={cn(
                "flex size-4 items-center justify-center rounded-full border",
                project.completed
                  ? "border-emerald-500 bg-emerald-500"
                  : "border-muted-foreground/40"
              )}
            />
            <span className="truncate">{project.name}</span>
            <div className="ml-auto flex items-center gap-1">
              {owner ? (
                <Avatar size="sm" className="size-4">
                  <AvatarFallback className={cn("text-[9px]", owner.color)}>
                    {owner.initials}
                  </AvatarFallback>
                </Avatar>
              ) : (
                <HugeiconsIcon
                  icon={UserCircleIcon}
                  strokeWidth={2}
                  className="size-4 text-muted-foreground"
                />
              )}
            </div>
          </div>
          <div
            className="relative grid h-full"
            style={{ gridTemplateColumns: `repeat(${months.length}, 1fr)` }}
          >
            {months.map((m, mIdx) => (
              <div
                key={m.key}
                className={cn(
                  "border-l",
                  todayIndex >= 0 && mIdx === todayIndex
                    ? "bg-primary/5"
                    : null
                )}
              />
            ))}
            {todayIndex >= 0 && idx === 0 ? (
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-primary/40"
                style={{
                  left: `calc(${(todayIndex / months.length) * 100}% + ${50 / months.length}%)`,
                }}
              />
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}

function buildMonthRange() {
  const today = new Date()
  const start = new Date(today.getFullYear(), today.getMonth() - 4, 1)
  const months: Array<{
    key: string
    label: string
    dayLabel: string
    isCurrent: boolean
  }> = []
  for (let i = 0; i < 12; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1)
    months.push({
      key: `${d.getFullYear()}-${d.getMonth()}`,
      label: d.toLocaleString("en-US", { month: "short" }).toUpperCase(),
      dayLabel: "1",
      isCurrent:
        d.getFullYear() === today.getFullYear() &&
        d.getMonth() === today.getMonth(),
    })
  }
  return months
}

function monthName(iso: string | null): string {
  const d = iso ? new Date(iso + "T00:00:00") : new Date()
  return d.toLocaleString("en-US", { month: "long" })
}

function currentMonthDay(): string {
  const d = new Date()
  return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`
}
