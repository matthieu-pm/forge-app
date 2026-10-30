import * as React from "react"
import { Add01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link, useBlocker } from "@tanstack/react-router"
import { toast } from "sonner"
import {
  PreferenceSyncStatus,
  usePreferenceGroup,
} from "./account-preference-provider"
import type {
  AgentPersonalization,
  PersonalSkill,
} from "@/lib/agent-personalization"
import {
  personalSkillSchema,
  replacePersonalSkill,
} from "@/lib/agent-personalization"
import { loadWorkspaceSecurity } from "@/lib/security-state"
import { useAgent } from "@/components/agent/agent-provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

function Section({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-12 first:mt-0">
      <div className="mb-3 px-4">
        <h2 className="text-[13px] leading-[18px] font-medium">{title}</h2>
        <p className="mt-1 text-[13px] leading-[21px] text-muted-foreground">
          {description}
        </p>
      </div>
      {children}
    </section>
  )
}
function SkillEditor({
  original,
  onSave,
  onClose,
}: {
  original: PersonalSkill | null
  onSave: (name: string, instructions: string) => void
  onClose: () => void
}) {
  const [name, setName] = React.useState(original?.name ?? "")
  const [instructions, setInstructions] = React.useState(
    original?.instructions ?? ""
  )
  const [error, setError] = React.useState<string | null>(null)
  const [discard, setDiscard] = React.useState(false)
  const dirty =
    name !== (original?.name ?? "") ||
    instructions !== (original?.instructions ?? "")
  useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: dirty })
  function close() {
    if (dirty) setDiscard(true)
    else onClose()
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close()
        }}
      >
        <DialogContent className="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle>
              {original ? "Edit skill" : "Create skill"}
            </DialogTitle>
            <DialogDescription>
              Save a reusable prompt for your Forge Agent conversations.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              try {
                onSave(name, instructions)
              } catch (reason) {
                setError(
                  reason instanceof Error
                    ? reason.message
                    : "Could not save this skill. Please try again."
                )
              }
            }}
          >
            <label className="grid gap-2 text-[13px]">
              Name
              <Input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                placeholder="e.g. Review accessibility"
                required
              />
            </label>
            <label className="grid gap-2 text-[13px]">
              Instructions
              <textarea
                className="min-h-52 resize-y rounded-lg bg-muted/60 p-3 text-[13px] leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                maxLength={50000}
                placeholder="Describe what the agent should do…"
                required
              />
            </label>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button type="submit">
                {original ? "Save changes" : "Create skill"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard changes?</DialogTitle>
            <DialogDescription>
              Your changes to this skill haven’t been saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDiscard(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={onClose}>
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
export function AgentPersonalizationSettings({ userId }: { userId: string }) {
  const agent = useAgent()
  const sync = usePreferenceGroup("agent", userId)
  const preferences = sync.preferences
  const [guidance, setGuidance] = React.useState("")
  const guidanceRef = React.useRef("")
  const savedGuidance = React.useRef("")
  const ready = sync.editable
  const [error, setError] = React.useState<string | null>(null)
  const [saveStatus, setSaveStatus] = React.useState("")
  const [editor, setEditor] = React.useState<PersonalSkill | "new" | null>(null)
  const [deleting, setDeleting] = React.useState<PersonalSkill | null>(null)
  const [mcp, setMcp] = React.useState<
    "loading" | "enabled" | "disabled" | "error"
  >("loading")
  const [mcpRefresh, refreshMcp] = React.useReducer((value) => value + 1, 0)
  const dirty = guidance !== preferences.guidance
  useBlocker({ shouldBlockFn: () => dirty, enableBeforeUnload: dirty })
  React.useEffect(() => {
    if (guidanceRef.current === savedGuidance.current) {
      setGuidance(preferences.guidance)
      guidanceRef.current = preferences.guidance
      savedGuidance.current = preferences.guidance
    }
  }, [preferences.guidance])
  React.useEffect(() => {
    setGuidance("")
    guidanceRef.current = ""
    savedGuidance.current = ""
    setEditor(null)
    setDeleting(null)
    setError(null)
    setSaveStatus("")
  }, [userId])
  React.useEffect(() => {
    let cancelled = false
    setMcp("loading")
    void loadWorkspaceSecurity()
      .then((snapshot) => {
        if (!cancelled)
          setMcp(snapshot.settings.mcpServersEnabled ? "enabled" : "disabled")
      })
      .catch(() => {
        if (!cancelled) setMcp("error")
      })
    return () => {
      cancelled = true
    }
  }, [mcpRefresh])
  function editPersonalization(
    change: (current: AgentPersonalization) => AgentPersonalization
  ) {
    const next = change(preferences)
    sync.update(next)
    return next
  }
  function saveGuidance() {
    if (!ready || guidance === savedGuidance.current) return
    try {
      editPersonalization((current) => {
        if (current.guidance !== savedGuidance.current)
          throw new Error(
            "Your guidance changed elsewhere. Reload before saving your draft."
          )
        return { ...current, guidance }
      })
      savedGuidance.current = guidance
      setSaveStatus("")
      setError(null)
    } catch (reason) {
      setError(
        reason instanceof Error && reason.message.includes("changed elsewhere")
          ? reason.message
          : "Could not save your guidance. Your draft is still here. Try saving again."
      )
    }
  }
  function saveSkill(name: string, instructions: string) {
    const original = editor === "new" ? null : editor
    const parsed = personalSkillSchema.safeParse({
      id: original?.id ?? crypto.randomUUID(),
      name,
      instructions,
      createdAt: original?.createdAt ?? new Date().toISOString(),
      revision: original?.revision ?? 0,
    })
    if (!parsed.success) throw new Error(parsed.error.issues[0].message)
    const skill = parsed.data
    editPersonalization((current) =>
      original
        ? replacePersonalSkill(current, original, skill)
        : { ...current, skills: [...current.skills, skill] }
    )
    setEditor(null)
  }
  function deleteSkill() {
    if (!deleting) return
    try {
      editPersonalization((current) =>
        replacePersonalSkill(current, deleting, null)
      )
      setDeleting(null)
    } catch (reason) {
      toast.error(
        reason instanceof Error
          ? reason.message
          : "Could not delete this skill."
      )
    }
  }
  return (
    <main className="forge-settings-scroll">
      <div className="forge-settings-content">
        <header className="forge-page-header forge-settings-header">
          <h1>Agent personalization</h1>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            Your personal settings for Forge Agent
          </p>
        </header>
        <PreferenceSyncStatus />
        <div>
          <Section
            title="Guidance"
            description="Provide personal instructions and context for the Forge Agent when responding to conversations"
          >
            <textarea
              aria-label="AI prompt rules"
              aria-describedby={error ? "personalization-error" : undefined}
              disabled={!ready || (!!error && !dirty)}
              className="block h-[180px] w-full resize-none rounded-xl bg-muted/60 px-4 py-4 text-[13px] leading-5 outline-none placeholder:text-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
              placeholder="Enter personal guidance for the Forge Agent (optional)…"
              value={guidance}
              maxLength={50000}
              onChange={(event) => {
                setGuidance(event.target.value)
                guidanceRef.current = event.target.value
                setSaveStatus("Unsaved changes")
              }}
              onBlur={saveGuidance}
            />
            {(saveStatus || error) && (
              <div className="mt-2 flex items-center justify-between gap-3 px-4 text-xs">
                <p
                  id="personalization-error"
                  role={error ? "alert" : "status"}
                  className={
                    error ? "text-destructive" : "text-muted-foreground"
                  }
                >
                  {error ?? saveStatus}
                </p>
                {dirty && (
                  <Button size="sm" variant="ghost" onClick={saveGuidance}>
                    Save guidance
                  </Button>
                )}
              </div>
            )}
          </Section>
          <Section
            title="Skills"
            description="Reusable prompts for the agent, ready to use in your conversations"
          >
            <div className="overflow-hidden rounded-xl bg-muted/60 px-4">
              <div className="flex min-h-16 items-center justify-between gap-4">
                <p className="text-[13px]">
                  {!ready
                    ? "Loading skills…"
                    : preferences.skills.length
                      ? `${preferences.skills.length} ${preferences.skills.length === 1 ? "skill" : "skills"}`
                      : "No skills created"}
                </p>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Create skill"
                  title="Create skill"
                  disabled={!ready || !!error}
                  onClick={() => setEditor("new")}
                >
                  <HugeiconsIcon
                    icon={Add01Icon}
                    className="size-3.5 text-muted-foreground"
                  />
                </Button>
              </div>
              {preferences.skills.map((skill) => (
                <div
                  key={skill.id}
                  className="flex min-h-16 items-center justify-between gap-4 border-t border-border/40"
                >
                  <button
                    aria-label={`Edit skill ${skill.name}`}
                    className="min-w-0 flex-1 rounded-md py-3 text-left outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setEditor(skill)}
                  >
                    <span className="block truncate text-[13px]">
                      {skill.name}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {skill.instructions}
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Actions for ${skill.name}`}
                        />
                      }
                    >
                      <HugeiconsIcon icon={MoreHorizontalIcon} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setEditor(skill)}>
                        Edit
                      </DropdownMenuItem>
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
                        Use in chat
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => setDeleting(skill)}
                      >
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          </Section>
          <Section
            title="MCP connectors"
            description="Add MCP connectors for use with Forge Agent. Workspace admins can manage available connectors in security settings."
          >
            <div className="flex min-h-16 items-center justify-between gap-4 rounded-xl bg-muted/60 px-4 py-3 max-sm:flex-wrap">
              <p className="text-[13px]" role="status">
                {mcp === "loading"
                  ? "Checking workspace MCP access…"
                  : mcp === "error"
                    ? "Workspace MCP access could not be loaded"
                    : mcp === "disabled"
                      ? "Agent MCP access disabled in this workspace"
                      : "Agent MCP access enabled in this workspace"}
              </p>
              {mcp === "error" ? (
                <Button size="sm" variant="ghost" onClick={refreshMcp}>
                  Retry
                </Button>
              ) : (
                <Link
                  to="/settings/security"
                  hash="forge-agent-mcp-servers"
                  className="shrink-0 rounded-md px-2 py-1 text-[13px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Configure
                </Link>
              )}
            </div>
          </Section>
        </div>
      </div>
      {editor !== null && (
        <SkillEditor
          original={editor === "new" ? null : editor}
          onSave={saveSkill}
          onClose={() => setEditor(null)}
        />
      )}
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleting?.name}?</DialogTitle>
            <DialogDescription>
              This removes the saved skill from your account.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteSkill}>
              Delete skill
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}
