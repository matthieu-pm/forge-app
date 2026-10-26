"use client"

import * as React from "react"
import { Link, useBlocker, useNavigate } from "@tanstack/react-router"
import {
  Add01Icon,
  BubbleChatIcon,
  Delete02Icon,
  Link01Icon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  UserGroup03Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { formatDistanceToNow } from "date-fns"
import { toast } from "sonner"
import type { ReactNode } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamAgentSkill } from "@/lib/team-agent-skills"
import {
  agentSkillSchema,
  replaceAgentSkill,
  useAgentSkills,
  writeAgentSkills,
} from "@/lib/team-agent-skills"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { useAgent } from "@/components/agent/agent-provider"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const focusClass =
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
const listPath = "/settings/teams/$teamSlug/agent-skills"
const editPath = "/settings/teams/$teamSlug/agent-skills/$skillId"
const purpleButton = "bg-[#5e6ad2] text-white hover:bg-[#535fc3]"

function SkillsShell({
  children,
}: {
  team: TeamSummary
  editor?: boolean
  children: ReactNode
}) {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="forge-settings-scroll">
        <div className="forge-settings-content">{children}</div>
      </div>
    </main>
  )
}
function SkillError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mb-4 px-4 text-sm text-destructive">
      {children}
    </p>
  )
}
function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Your changes could not be saved. Please try again."
}

export function TeamAgentSkillsSettings({
  team,
  teams,
}: {
  team: TeamSummary
  teams: Array<TeamSummary>
}) {
  const store = useAgentSkills()
  const skills = store.skills.filter((skill) => skill.teamId === team.id)
  const [deleting, setDeleting] = React.useState<TeamAgentSkill | null>(null)
  const navigate = useNavigate()
  const agent = useAgent()
  const disabled = !store.ready || !!store.error
  function edit(skill: TeamAgentSkill) {
    void navigate({
      to: editPath,
      params: { teamSlug: team.slug, skillId: skill.id },
    })
  }
  function move(skill: TeamAgentSkill, target: TeamSummary) {
    try {
      writeAgentSkills((current) =>
        replaceAgentSkill(current, skill, { teamId: target.id })
      )
      toast.success(`Moved to ${target.name}`)
    } catch (error) {
      toast.error(errorMessage(error))
    }
  }
  async function copyLink(skill: TeamAgentSkill) {
    try {
      await navigator.clipboard.writeText(
        new URL(
          `/settings/teams/${encodeURIComponent(team.slug)}/agent-skills/${encodeURIComponent(skill.id)}`,
          window.location.origin
        ).href
      )
      toast.success("Link copied")
    } catch {
      toast.error("The link could not be copied. Please try again.")
    }
  }
  return (
    <SkillsShell team={team}>
      <header className="forge-page-header forge-settings-header">
        <h1>Agent skills</h1>
        <p className="mt-1.5 text-sm leading-[22px] text-muted-foreground">
          Add reusable instructions team members can use with Forge Agent
        </p>
      </header>
      {store.error && <SkillError>{store.error}</SkillError>}
      <section
        aria-label="Agent skills"
        className="overflow-hidden rounded-xl bg-muted/35 ring-1 ring-border/30"
      >
        <div className="flex min-h-[60px] items-center justify-between gap-4 px-4 py-3">
          <h2 className="text-sm">
            {!store.ready
              ? "Loading skills…"
              : store.error
                ? "Skills unavailable"
                : skills.length
                  ? `${skills.length} ${skills.length === 1 ? "skill" : "skills"}`
                  : "No skills created"}
          </h2>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Create skill"
                  disabled={disabled}
                  onClick={() =>
                    void navigate({
                      to: "/settings/teams/$teamSlug/agent-skills/new",
                      params: { teamSlug: team.slug },
                    })
                  }
                />
              }
            >
              <HugeiconsIcon
                icon={Add01Icon}
                className="size-4"
                strokeWidth={1.5}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom">Create skill</TooltipContent>
          </Tooltip>
        </div>
        {!store.error && skills.length > 0 && (
          <ul>
            {skills.map((skill) => (
              <li
                key={skill.id}
                className="group flex min-h-[68px] items-center gap-3 border-t border-border/40 px-4 py-3"
              >
                <Link
                  to={editPath}
                  params={{ teamSlug: team.slug, skillId: skill.id }}
                  className={`min-w-0 flex-1 rounded-md ${focusClass}`}
                >
                  <span className="block truncate text-sm">{skill.name}</span>
                  <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                    Created{" "}
                    <time
                      dateTime={skill.createdAt}
                      title={new Date(skill.createdAt).toLocaleString()}
                    >
                      {Date.now() - Date.parse(skill.createdAt) < 60000
                        ? "just now"
                        : formatDistanceToNow(new Date(skill.createdAt), {
                            addSuffix: true,
                          })}
                    </time>
                  </span>
                </Link>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Open menu for ${skill.name}`}
                        className="text-muted-foreground data-popup-open:bg-muted data-popup-open:opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
                      />
                    }
                  >
                    <HugeiconsIcon
                      icon={MoreHorizontalIcon}
                      className="size-4"
                      strokeWidth={1.5}
                    />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="w-44 rounded-xl motion-reduce:animate-none"
                  >
                    <DropdownMenuItem onClick={() => edit(skill)}>
                      <HugeiconsIcon icon={PencilEdit02Icon} />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        <HugeiconsIcon icon={UserGroup03Icon} />
                        Move to team
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-h-72 overflow-y-auto rounded-xl motion-reduce:animate-none">
                        {teams
                          .filter((target) => target.id !== team.id)
                          .map((target) => (
                            <DropdownMenuItem
                              key={target.id}
                              onClick={() => move(skill, target)}
                            >
                              <TeamSidebarIcon
                                icon={target.icon}
                                name={target.name}
                                className="size-4"
                              />
                              {target.name}
                            </DropdownMenuItem>
                          ))}
                        {teams.every((target) => target.id === team.id) && (
                          <DropdownMenuItem disabled>
                            No other teams
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuItem onClick={() => void copyLink(skill)}>
                      <HugeiconsIcon icon={Link01Icon} />
                      Copy link
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => {
                        agent.setDraft(
                          [agent.draft, skill.instructions]
                            .filter(Boolean)
                            .join("\n\n")
                        )
                        agent.openComposer("floating")
                      }}
                    >
                      <HugeiconsIcon icon={BubbleChatIcon} />
                      Use in chat
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setDeleting(skill)}>
                      <HugeiconsIcon icon={Delete02Icon} />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete skill?</DialogTitle>
            <DialogDescription>
              “{deleting?.name}” will be removed from this team.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!deleting) return
                try {
                  writeAgentSkills((current) =>
                    replaceAgentSkill(current, deleting, null)
                  )
                  setDeleting(null)
                  toast.success("Skill deleted")
                } catch (error) {
                  toast.error(errorMessage(error))
                }
              }}
            >
              Delete skill
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SkillsShell>
  )
}

export function TeamAgentSkillEditor({
  team,
  skillId,
}: {
  team: TeamSummary
  skillId?: string
}) {
  const store = useAgentSkills()
  const skill = store.skills.find(
    (item) => item.id === skillId && item.teamId === team.id
  )
  if (!store.ready || store.error || (skillId && !skill))
    return (
      <SkillsShell team={team} editor>
        {store.error ? (
          <SkillError>{store.error}</SkillError>
        ) : (
          <p className="px-4 text-sm text-muted-foreground">
            {!store.ready
              ? "Loading skill…"
              : "This skill is unavailable or has moved to another team."}
          </p>
        )}
      </SkillsShell>
    )
  return <SkillEditorForm key={skillId ?? "new"} team={team} skill={skill} />
}
function SkillEditorForm({
  team,
  skill,
}: {
  team: TeamSummary
  skill?: TeamAgentSkill
}) {
  const [original] = React.useState(skill)
  const [name, setName] = React.useState(skill?.name ?? "")
  const [instructions, setInstructions] = React.useState(
    skill?.instructions ?? ""
  )
  const [error, setError] = React.useState("")
  const safeToLeave = React.useRef(false)
  const nameRef = React.useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const dirty =
    name !== (original?.name ?? "") ||
    instructions !== (original?.instructions ?? "")
  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !safeToLeave.current,
    enableBeforeUnload: () => dirty && !safeToLeave.current,
    withResolver: true,
  })
  React.useEffect(() => {
    nameRef.current?.focus()
  }, [])
  function leave() {
    void navigate({ to: listPath, params: { teamSlug: team.slug } })
  }
  function save(event: React.FormEvent) {
    event.preventDefault()
    const parsed = agentSkillSchema.safeParse({
      id: original?.id ?? crypto.randomUUID(),
      teamId: team.id,
      name,
      instructions,
      createdAt: original?.createdAt ?? new Date().toISOString(),
      revision: original?.revision ?? 0,
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the skill fields.")
      if (!name.trim()) nameRef.current?.focus()
      return
    }
    try {
      writeAgentSkills((current) =>
        original
          ? replaceAgentSkill(current, original, {
              name: parsed.data.name,
              instructions: parsed.data.instructions,
            })
          : [...current, parsed.data]
      )
      safeToLeave.current = true
      leave()
    } catch (saveError) {
      setError(errorMessage(saveError))
    }
  }
  return (
    <SkillsShell team={team} editor>
      <form onSubmit={save}>
        <h1 className="sr-only">{original ? "Edit skill" : "New skill"}</h1>
        <input
          ref={nameRef}
          aria-label="Skill name"
          placeholder="Skill name"
          maxLength={120}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            setError("")
          }}
          className={`mb-6 w-full min-w-0 rounded-md bg-transparent px-4 py-0.5 text-2xl font-medium tracking-tight placeholder:text-muted-foreground/60 ${focusClass}`}
        />
        <textarea
          aria-label="Skill instructions"
          placeholder="Add instructions…"
          maxLength={50000}
          value={instructions}
          onChange={(event) => {
            setInstructions(event.target.value)
            setError("")
          }}
          className={`block min-h-[272px] w-full resize-y rounded-xl bg-muted/35 p-4 text-sm leading-6 ring-1 ring-border/30 placeholder:text-muted-foreground/60 ${focusClass}`}
        />
        {error && (
          <div className="mt-3">
            <SkillError>{error}</SkillError>
          </div>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={leave}>
            Cancel
          </Button>
          <Button type="submit" className={purpleButton}>
            {original ? "Save" : "Create"}
          </Button>
        </div>
      </form>
      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.()
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Your changes to this skill have not been saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => blocker.reset?.()}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={() => blocker.proceed?.()}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SkillsShell>
  )
}
