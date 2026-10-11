import * as React from "react"
import { useBlocker, useNavigate, useRouter } from "@tanstack/react-router"
import { toast } from "sonner"
import { FormBuilder } from "./form-builder"
import {
  Glyph,
  Picker,
  Properties,
  SaveFooter,
  TemplateShell,
} from "./template-controls"
import { IssueItems, Milestones } from "./template-items"
import { RichEditor } from "./rich-editor"
import type {
  SavedTemplate,
  TemplateDirectory,
  TemplateDraft,
  TemplateKind,
} from "@/lib/template-contract"
import type { TeamSummary } from "@/lib/team-contract"
import { emptyTemplate, templatePayloadSchema } from "@/lib/template-contract"
import { saveTemplate } from "@/lib/template-state"
import { TeamIconPicker } from "@/components/team-icon-picker"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const inlineInput =
  "w-full min-w-0 border-0 bg-transparent px-0 outline-none placeholder:text-muted-foreground/55 focus-visible:rounded-sm focus-visible:ring-1 focus-visible:ring-ring/40"
export function TemplateEditor({
  kind,
  team,
  directory,
  saved,
  form = false,
}: {
  kind: TemplateKind
  team: TeamSummary
  directory: TemplateDirectory
  saved?: SavedTemplate
  form?: boolean
}) {
  const [draft, setDraft] = React.useState<TemplateDraft>(
    () =>
      saved?.payload ?? {
        ...emptyTemplate(kind, team.id),
        issueType: form ? "form" : "standard",
      }
  )
  const [saving, setSaving] = React.useState(false)
  const [milestoneCreating, setMilestoneCreating] = React.useState(false)
  const [issueCreating, setIssueCreating] = React.useState(false)
  const [subIssueCreating, setSubIssueCreating] = React.useState(false)
  const [error, setError] = React.useState("")
  const initial = React.useRef(JSON.stringify(draft))
  const safeToLeave = React.useRef(false)
  const dirty =
    JSON.stringify(draft) !== initial.current ||
    milestoneCreating ||
    issueCreating ||
    subIssueCreating
  const navigate = useNavigate()
  const router = useRouter()
  const nameRef = React.useRef<HTMLInputElement>(null)
  const blocker = useBlocker({
    shouldBlockFn: () => dirty && !safeToLeave.current,
    enableBeforeUnload: () => dirty && !safeToLeave.current,
    withResolver: true,
  })
  const patch = <TKey extends keyof TemplateDraft>(
    key: TKey,
    value: TemplateDraft[TKey]
  ) => setDraft((current) => ({ ...current, [key]: value }))
  function cancel() {
    void navigate({
      to: "/settings/teams/$teamSlug/templates",
      params: { teamSlug: team.slug },
    })
  }
  async function save() {
    if (saving) return
    const parsed = templatePayloadSchema.safeParse(draft)
    if (!parsed.success) {
      const message =
        parsed.error.issues[0]?.message ?? "Check the template fields."
      setError(message)
      toast.error(message)
      if (!draft.name.trim()) nameRef.current?.focus()
      return
    }
    if (milestoneCreating || issueCreating || subIssueCreating) {
      toast.error(
        "Add or cancel the open milestone or issue before saving the template."
      )
      return
    }
    setSaving(true)
    setError("")
    try {
      await saveTemplate({
        data: {
          slug: team.slug,
          id: saved?.id,
          updatedAt: saved?.updatedAt,
          payload: parsed.data,
        },
      })
      safeToLeave.current = true
      await router.invalidate()
      toast.success(saved ? "Template updated." : "Template created.")
      cancel()
    } catch (failure) {
      const message =
        failure instanceof Error
          ? failure.message
          : "Could not save template. Your changes are still here."
      setError(message)
      toast.error(message)
      safeToLeave.current = false
    } finally {
      setSaving(false)
    }
  }
  const saveRef = React.useRef(save)
  saveRef.current = save
  React.useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey) {
        if (
          event.key === "Enter" &&
          !milestoneCreating &&
          !issueCreating &&
          !subIssueCreating
        ) {
          event.preventDefault()
          void saveRef.current()
        }
        if (
          event.shiftKey &&
          event.key.toLowerCase() === "m" &&
          kind === "project"
        ) {
          event.preventDefault()
          setMilestoneCreating(true)
        }
        if (
          event.shiftKey &&
          event.key.toLowerCase() === "o" &&
          kind !== "document"
        ) {
          event.preventDefault()
          if (kind === "project") setIssueCreating(true)
          else setSubIssueCreating(true)
        }
      }
    }
    document.addEventListener("keydown", shortcut)
    return () => document.removeEventListener("keydown", shortcut)
  }, [kind, milestoneCreating, issueCreating, subIssueCreating])
  const iconPicker = (
    <TeamIconPicker
      name={draft.name || "Template"}
      label={
        kind === "project" ? "Choose project icon" : "Choose template icon"
      }
      value={draft.icon}
      onChange={(value) => patch("icon", value)}
      className="size-7 rounded-md border-0 bg-muted/80"
    />
  )
  const footer = (
    <SaveFooter
      onCancel={cancel}
      onSave={() => void save()}
      saving={saving}
      canSave={directory.canManage}
      edit={!!saved}
    >
      {kind === "project" && (
        <>
          <span className="mr-4 text-xs">Visibility</span>
          <Picker
            label="Template visibility"
            value={draft.visibility}
            options={directory.teams.map((t) => ({
              value: t.id,
              label: t.name,
              icon: <TeamSidebarIcon icon={t.icon} name={t.name} />,
            }))}
            onChange={(value) =>
              patch("visibility", typeof value === "string" ? value : team.id)
            }
            className="mr-0 h-8 px-3"
          >
            <TeamSidebarIcon
              icon={
                (directory.teams.find((t) => t.id === draft.visibility) ?? team)
                  .icon
              }
              name={team.name}
            />
            {directory.teams.find((t) => t.id === draft.visibility)?.name ??
              team.name}
          </Picker>
        </>
      )}
    </SaveFooter>
  )
  return (
    <TemplateShell team={team}>
      <div className="mx-auto w-full max-w-[750px] pt-4 pb-12">
        {!directory.canManage && (
          <p className="mb-4 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            Only workspace owners and admins can save template changes.
          </p>
        )}
        {kind === "issue" ? (
          <>
            <div className="px-4">
              <div className="flex items-center gap-3">
                {iconPicker}
                <input
                  ref={nameRef}
                  aria-label="Template name"
                  placeholder="Template name"
                  value={draft.name}
                  onChange={(e) => patch("name", e.target.value)}
                  className={`${inlineInput} text-2xl font-semibold tracking-tight`}
                />
              </div>
              <input
                aria-label="Template description"
                placeholder="Add an optional template description..."
                value={draft.description}
                onChange={(e) => patch("description", e.target.value)}
                className={`${inlineInput} mt-2 text-[15px]`}
              />
            </div>
            <div className="mt-8 rounded-xl border border-border/40 bg-muted/35 p-4">
              <input
                aria-label="Issue title"
                placeholder="Issue title"
                value={draft.title}
                onChange={(e) => patch("title", e.target.value)}
                className={`${inlineInput} text-lg font-semibold`}
              />
              <div className="mt-3 min-h-[66px]">
                <RichEditor
                  label="Issue description"
                  value={draft.content}
                  onChange={(value) => patch("content", value)}
                />
              </div>
            </div>
            {draft.issueType === "form" && (
              <FormBuilder
                fields={draft.fields}
                onChange={(value) => patch("fields", value)}
              />
            )}
            <div className="mt-8 px-4">
              <h2 className="text-[15px] font-medium">Default properties</h2>
              <p className="mt-1 text-[13px] text-muted-foreground">
                Automatically applied upon issue creation, and editable when
                composing within Forge
              </p>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-border/40 bg-muted/35 px-5 py-4">
              <Properties
                team={team}
                directory={directory}
                value={draft.properties}
                onChange={(value) => patch("properties", value)}
              />
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label="More default properties"
                      className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-muted"
                    />
                  }
                >
                  <Glyph name="more" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48 rounded-xl">
                  <DropdownMenuItem onClick={() => setSubIssueCreating(true)}>
                    <Glyph name="add" />
                    Add sub-issue{" "}
                    <kbd className="ml-auto text-[10px] text-muted-foreground">
                      ⌘⇧O
                    </kbd>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <IssueItems
              subIssues
              items={draft.subIssues}
              onChange={(value) => patch("subIssues", value)}
              team={team}
              directory={directory}
              creating={subIssueCreating}
              onCreatingChange={setSubIssueCreating}
            />
            {error && (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="mt-8">{footer}</div>
          </>
        ) : kind === "project" ? (
          <>
            <h1 className="px-4 text-2xl font-medium tracking-tight">
              {saved ? "Edit project template" : "New project template"}
            </h1>
            <div className="mt-8">
              <label
                htmlFor="template-name"
                className="mb-2 block px-4 text-[13px]"
              >
                Name
              </label>
              <Input
                ref={nameRef}
                id="template-name"
                aria-label="Template name"
                placeholder="Add a descriptive name..."
                value={draft.name}
                onChange={(e) => patch("name", e.target.value)}
                className="h-8 rounded-lg border-border/60 bg-muted/35 px-3 text-xs"
              />
            </div>
            <div className="mt-6 rounded-xl border border-border/60 bg-muted/35 p-4">
              {iconPicker}
              <input
                aria-label="Project name"
                placeholder="Project name"
                value={draft.title}
                onChange={(e) => patch("title", e.target.value)}
                className={`${inlineInput} mt-3 text-2xl font-semibold tracking-tight`}
              />
              <input
                aria-label="Project summary"
                placeholder="Add a short summary..."
                value={draft.summary}
                onChange={(e) => patch("summary", e.target.value)}
                className={`${inlineInput} mt-2 text-[15px]`}
              />
              <div className="mt-3">
                <Properties
                  project
                  team={team}
                  directory={directory}
                  value={draft.properties}
                  onChange={(value) => patch("properties", value)}
                >
                  <button
                    type="button"
                    aria-label="Add project issue"
                    onClick={() => setIssueCreating(true)}
                    className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2 text-xs text-muted-foreground hover:bg-muted"
                  >
                    <Glyph name="document" />
                    {draft.issues.length
                      ? `${draft.issues.length} issue${draft.issues.length === 1 ? "" : "s"}`
                      : "Issues"}
                  </button>
                </Properties>
              </div>
              <div className="mt-5 border-t border-border pt-6">
                <div className="min-h-[140px]">
                  <RichEditor
                    label="Project description"
                    value={draft.content}
                    onChange={(value) => patch("content", value)}
                    placeholder="Write a description, a project brief, or collect ideas..."
                  />
                </div>
              </div>
              <Milestones
                items={draft.milestones}
                onChange={(value) => patch("milestones", value)}
                creating={milestoneCreating}
                onCreatingChange={setMilestoneCreating}
              />
              <IssueItems
                items={draft.issues}
                onChange={(value) => patch("issues", value)}
                team={team}
                directory={directory}
                creating={issueCreating}
                onCreatingChange={setIssueCreating}
              />
            </div>
            {error && (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {error}
              </p>
            )}
            {footer}
          </>
        ) : (
          <>
            <h1 className="border-b border-border/50 px-2 pb-6 text-2xl font-medium tracking-tight">
              {saved ? "Edit document template" : "New document template"}
            </h1>
            <div className="px-2 pt-8">
              {iconPicker}
              <input
                ref={nameRef}
                aria-label="Template name"
                placeholder="Template name"
                value={draft.name}
                onChange={(e) => patch("name", e.target.value)}
                className={`${inlineInput} mt-3 text-2xl font-semibold tracking-tight`}
              />
              <div className="mt-10 min-h-[88px]">
                <RichEditor
                  label="Document content"
                  value={draft.content}
                  onChange={(value) => patch("content", value)}
                  placeholder="Click here to start writing..."
                />
              </div>
              {error && (
                <p role="alert" className="mt-3 text-xs text-destructive">
                  {error}
                </p>
              )}
              {footer}
            </div>
          </>
        )}
      </div>
      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.()
        }}
      >
        <DialogContent className="rounded-xl sm:max-w-sm">
          <DialogTitle>Discard unsaved changes?</DialogTitle>
          <DialogDescription>
            Your template has changes that haven’t been saved.
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => blocker.reset?.()}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={() => blocker.proceed?.()}>
              Discard changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </TemplateShell>
  )
}
