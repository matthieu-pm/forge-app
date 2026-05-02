import * as React from "react"
import { Link } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Calendar03Icon,
  CancelCircleIcon,
  FilterHorizontalIcon,
  PlusSignIcon,
  Rocket01Icon,
  SlidersHorizontalIcon,
  Tick02Icon,
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
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  formatTargetDate,
  getOwner,
  getProjects,
  isPastDate,
  MOCK_OWNERS,
  MOCK_PROJECTS,
  type Initiative,
  type InitiativeOwner,
  type InitiativeStatus,
  type Project,
} from "@/lib/initiatives-data"
import {
  addInitiative,
  updateInitiative,
  useInitiatives,
} from "@/lib/initiatives-store"

const STATUS_TABS: { value: InitiativeStatus; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "planned", label: "Planned" },
  { value: "completed", label: "Completed" },
]

const ACCENT_PALETTE = [
  "bg-rose-500",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-sky-500",
  "bg-violet-500",
  "bg-zinc-800",
]

function newInitiativeId() {
  return `i-${Math.random().toString(36).slice(2, 10)}`
}

export function InitiativesPage() {
  const initiatives = useInitiatives()
  const [tab, setTab] = React.useState<InitiativeStatus>("active")
  const [creating, setCreating] = React.useState(false)

  const visible = React.useMemo(
    () => initiatives.filter((i) => i.status === tab),
    [initiatives, tab]
  )

  function handleCreate(draft: Initiative) {
    addInitiative(draft)
    setCreating(false)
  }

  function handleUpdate(id: string, patch: Partial<Initiative>) {
    updateInitiative(id, patch)
  }

  return (
    <div className="flex flex-1 flex-col">
      <PageTitleRow onAdd={() => setCreating(true)} />
      <FilterRow
        tab={tab}
        onTabChange={(value) => setTab(value)}
      />
      <TableHeader />
      <div className="flex flex-col">
        {creating ? (
          <NewInitiativeRow
            onCancel={() => setCreating(false)}
            onCreate={handleCreate}
            status={tab}
          />
        ) : null}
        {visible.map((initiative) => (
          <InitiativeRow
            key={initiative.id}
            initiative={initiative}
            onUpdate={(patch) => handleUpdate(initiative.id, patch)}
          />
        ))}
        {!creating && visible.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            No {tab} initiatives.
          </div>
        ) : null}
      </div>
    </div>
  )
}

function PageTitleRow({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between border-b px-4">
      <h1 className="text-sm font-medium">Initiatives</h1>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="New initiative"
        onClick={onAdd}
      >
        <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
      </Button>
    </div>
  )
}

function FilterRow({
  tab,
  onTabChange,
}: {
  tab: InitiativeStatus
  onTabChange: (value: InitiativeStatus) => void
}) {
  return (
    <div className="flex h-11 shrink-0 items-center justify-between border-b px-4">
      <Tabs
        value={tab}
        onValueChange={(value) => onTabChange(value as InitiativeStatus)}
        className="shrink-0"
      >
        <TabsList
          aria-label="Initiative status"
          className="h-auto items-center gap-1 bg-transparent p-0"
        >
          {STATUS_TABS.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              className={cn(
                "h-7 flex-none rounded-full border border-transparent bg-transparent px-3 py-0.5 text-sm text-muted-foreground hover:text-foreground after:hidden",
                "data-active:border-transparent data-active:bg-muted data-active:font-medium data-active:text-foreground"
              )}
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
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
    </div>
  )
}

function TableHeader() {
  return (
    <div className="grid h-9 shrink-0 items-center gap-3 border-b px-4 text-xs text-muted-foreground [grid-template-columns:1fr_120px_120px_90px_140px_120px]">
      <div>Name</div>
      <div>Owner</div>
      <div>Target</div>
      <div>Projects</div>
      <div>Initiative Health</div>
      <div>Active Projects</div>
    </div>
  )
}

function InitiativeRow({
  initiative,
  onUpdate,
}: {
  initiative: Initiative
  onUpdate: (patch: Partial<Initiative>) => void
}) {
  const owner = getOwner(initiative.ownerId)
  const projects = getProjects(initiative.projectIds)
  const completedCount = projects.filter((p) => p.completed).length
  const activeCount = projects.length - completedCount
  const targetLabel = formatTargetDate(initiative.targetDate)
  const overdue = isPastDate(initiative.targetDate)

  return (
    <div className="grid items-center gap-3 border-b px-4 py-2.5 text-sm hover:bg-muted/40 [grid-template-columns:1fr_120px_120px_90px_140px_120px]">
      <Link
        to="/workspace/initiatives/$initiativeId"
        params={{ initiativeId: initiative.id }}
        className="flex min-w-0 items-start gap-3"
      >
        <InitiativeIcon accent={initiative.accentColor} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium hover:underline">
            {initiative.name}
          </span>
          {initiative.description ? (
            <span className="truncate text-xs text-muted-foreground">
              {initiative.description}
            </span>
          ) : null}
        </div>
      </Link>
      <OwnerCell
        owner={owner}
        onChange={(o) => onUpdate({ ownerId: o ? o.id : null })}
      />
      <TargetDateCell
        targetDate={initiative.targetDate}
        label={targetLabel}
        overdue={overdue}
        onChange={(iso) => onUpdate({ targetDate: iso })}
      />
      <ProjectsCell
        projectIds={initiative.projectIds}
        completedCount={completedCount}
        onChange={(ids) => onUpdate({ projectIds: ids })}
      />
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="inline-block size-2 rounded-full border border-dashed border-muted-foreground/60" />
        <span>No updates</span>
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        {activeCount > 0 ? (
          <>
            <span className="inline-block size-2 rounded-full bg-emerald-500" />
            <span>{activeCount}</span>
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
    </div>
  )
}

function InitiativeIcon({ accent }: { accent: string }) {
  return (
    <span
      className={cn(
        "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-white",
        accent
      )}
    >
      <HugeiconsIcon
        icon={Rocket01Icon}
        strokeWidth={2}
        className="size-3"
      />
    </span>
  )
}

function NewInitiativeRow({
  onCancel,
  onCreate,
  status,
}: {
  onCancel: () => void
  onCreate: (init: Initiative) => void
  status: InitiativeStatus
}) {
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [targetDate, setTargetDate] = React.useState<string | null>(null)
  const [ownerId, setOwnerId] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const owner = getOwner(ownerId)
  const canCreate = name.trim().length > 0

  function submit() {
    if (!canCreate) return
    const accent =
      ACCENT_PALETTE[Math.floor(Math.random() * ACCENT_PALETTE.length)]
    onCreate({
      id: newInitiativeId(),
      name: name.trim(),
      description: description.trim(),
      ownerId,
      targetDate,
      projectIds: [],
      status,
      health: "no-updates",
      accentColor: accent,
    })
  }

  return (
    <div className="flex flex-col gap-2 border-b bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-3">
        <InitiativeIcon accent="bg-rose-500" />
        <Input
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New initiative"
          className="h-7 border-0 bg-transparent px-0 text-sm font-medium shadow-none focus-visible:ring-0"
          onKeyDown={(e) => {
            if (e.key === "Enter") submit()
            if (e.key === "Escape") onCancel()
          }}
        />
      </div>
      <Input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Add a short summary..."
        className="h-7 border-0 bg-transparent px-0 pl-8 text-xs text-muted-foreground shadow-none focus-visible:ring-0"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit()
          if (e.key === "Escape") onCancel()
        }}
      />
      <div className="flex items-center justify-between pl-8">
        <div className="flex items-center gap-2">
          <TargetDatePopover
            targetDate={targetDate}
            onChange={setTargetDate}
            trigger={
              <Button variant="outline" size="sm" className="text-xs">
                <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} />
                {targetDate ? formatTargetDate(targetDate) : "Target date"}
              </Button>
            }
          />
          <OwnerPopover
            ownerId={ownerId}
            onChange={(id) => setOwnerId(id)}
            trigger={
              <Button variant="outline" size="sm" className="text-xs">
                {owner ? (
                  <Avatar size="sm" className="size-4">
                    <AvatarFallback
                      className={cn("text-[9px]", owner.color)}
                    >
                      {owner.initials}
                    </AvatarFallback>
                  </Avatar>
                ) : (
                  <HugeiconsIcon icon={UserCircleIcon} strokeWidth={2} />
                )}
                {owner ? owner.name : "Owner"}
              </Button>
            }
          />
        </div>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={!canCreate} onClick={submit}>
            Create
          </Button>
        </div>
      </div>
    </div>
  )
}

function OwnerCell({
  owner,
  onChange,
}: {
  owner: InitiativeOwner | null
  onChange: (owner: InitiativeOwner | null) => void
}) {
  return (
    <OwnerPopover
      ownerId={owner ? owner.id : null}
      onChange={(id) => onChange(id ? getOwner(id) : null)}
      trigger={
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          {owner ? (
            <>
              <Avatar size="sm" className="size-4">
                <AvatarFallback className={cn("text-[9px]", owner.color)}>
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
        </button>
      }
    />
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
              {MOCK_OWNERS.map((o) => (
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

function TargetDateCell({
  targetDate,
  label,
  overdue,
  onChange,
}: {
  targetDate: string | null
  label: string
  overdue: boolean
  onChange: (iso: string | null) => void
}) {
  return (
    <TargetDatePopover
      targetDate={targetDate}
      onChange={onChange}
      trigger={
        <button
          type="button"
          className={cn(
            "flex items-center gap-1.5 text-xs",
            targetDate
              ? overdue
                ? "text-rose-500"
                : "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <HugeiconsIcon
            icon={Calendar03Icon}
            strokeWidth={2}
            className={cn("size-3.5", overdue && "text-rose-500")}
          />
          <span>{label || "Set"}</span>
        </button>
      }
    />
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

function ProjectsCell({
  projectIds,
  completedCount,
  onChange,
}: {
  projectIds: string[]
  completedCount: number
  onChange: (ids: string[]) => void
}) {
  const [open, setOpen] = React.useState(false)
  const total = projectIds.length

  function toggle(id: string) {
    if (projectIds.includes(id)) {
      onChange(projectIds.filter((p) => p !== id))
    } else {
      onChange([...projectIds, id])
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <HugeiconsIcon
              icon={Tick02Icon}
              strokeWidth={2}
              className="size-3.5 text-violet-500"
            />
            <span>
              {completedCount} / {total}
            </span>
          </button>
        }
      />
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Add projects..." />
          <CommandList>
            <CommandEmpty>No projects found.</CommandEmpty>
            <CommandGroup>
              {MOCK_PROJECTS.map((p) => (
                <ProjectCommandItem
                  key={p.id}
                  project={p}
                  selected={projectIds.includes(p.id)}
                  onToggle={() => toggle(p.id)}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ProjectCommandItem({
  project,
  selected,
  onToggle,
}: {
  project: Project
  selected: boolean
  onToggle: () => void
}) {
  return (
    <CommandItem
      value={project.name}
      data-checked={selected}
      onSelect={onToggle}
    >
      <span
        className={cn(
          "flex size-4 items-center justify-center rounded-full border",
          project.completed
            ? "border-emerald-500 bg-emerald-500 text-white"
            : "border-muted-foreground/40"
        )}
      >
        {project.completed ? (
          <HugeiconsIcon
            icon={Tick02Icon}
            strokeWidth={3}
            className="size-2.5"
          />
        ) : null}
      </span>
      <span>{project.name}</span>
    </CommandItem>
  )
}
