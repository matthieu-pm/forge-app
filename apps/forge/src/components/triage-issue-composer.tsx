import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import type { JSONContent } from "@tiptap/core"
import type { TeamSummary } from "@/lib/team-contract"
import type { TemplateDirectory } from "@/lib/template-contract"
import type { TriageDraft } from "@/lib/triage-issues"
import { productStorage } from "@/lib/product-storage"
import { OptionSelect } from "@/components/ui/option-select"
import { loadTemplates } from "@/lib/template-state"
import {
  triageDraftKey,
  triageDraftSchema,
  triagePriorities,
} from "@/lib/triage-issues"
import { cn } from "@/lib/utils"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Glyph } from "@/components/templates/template-controls"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"

const chip = "max-w-44 gap-1 rounded-full px-2 text-xs font-normal"
const field =
  "w-full rounded-md border-0 bg-transparent px-1.5 outline-none placeholder:text-muted-foreground"
function Property({
  label,
  children,
  content,
}: {
  label: string
  children: ReactNode
  content: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            type="button"
            variant="secondary"
            className={chip}
            aria-label={label}
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 gap-3 rounded-xl p-3">
        {content}
      </PopoverContent>
    </Popover>
  )
}
function documentText(node: JSONContent): string {
  if (node.text) return node.text
  if (node.type === "hardBreak") return "\n"
  return (node.content ?? [])
    .map(documentText)
    .join(
      ["doc", "bulletList", "orderedList"].includes(node.type ?? "") ? "\n" : ""
    )
}
function ExpandIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path
        d={
          expanded
            ? "M2 6h4V2M14 10h-4v4M6 6 2 2m8 8 4 4"
            : "M10 2h4v4M6 14H2v-4M14 2l-5 5m-7 7 5-5"
        }
      />
    </svg>
  )
}
export function TriageIssueComposer({
  team,
  open,
  onOpenChange,
  draft,
  onDraftChange,
  editing,
  error,
  onError,
  onSave,
}: {
  team: TeamSummary
  open: boolean
  onOpenChange: (value: boolean) => void
  draft: TriageDraft
  onDraftChange: (draft: TriageDraft) => void
  editing: boolean
  error: string | null
  onError: (message: string | null) => void
  onSave: () => boolean | Promise<boolean>
}) {
  const [expanded, setExpanded] = useState(false)
  const [createMore, setCreateMore] = useState(false)
  const [directory, setDirectory] = useState<TemplateDirectory>()
  const [directoryError, setDirectoryError] = useState(false)
  const [templateOpen, setTemplateOpen] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => {
    if (!open) return
    let active = true
    setDirectory(undefined)
    setDirectoryError(false)
    loadTemplates({ data: { slug: team.slug } })
      .then((result) => {
        if (active) setDirectory(result)
      })
      .catch(() => {
        if (active) setDirectoryError(true)
      })
    return () => {
      active = false
    }
  }, [open, team.slug])
  function update(patch: Partial<TriageDraft>) {
    onDraftChange({ ...draft, ...patch })
  }
  const [saving, setSaving] = useState(false)
  const saveLock = useRef(false)
  async function submit() {
    if (!draft.title.trim() || attaching || saveLock.current) return
    saveLock.current = true
    setSaving(true)
    try {
      if (!(await onSave())) return
      if (!editing) {
        try {
          const key = triageDraftKey(team.id)
          const saved = productStorage.getItem(key)
          if (saved && triageDraftSchema.safeParse(JSON.parse(saved)).success)
            productStorage.removeItem(key)
        } catch {
          /* The issue is saved; do not repeat the creation. */
        }
      }
      if (!editing) {
        onDraftChange({
          ...draft,
          title: "",
          description: "",
          attachments: [],
          templateName: undefined,
        })
      }
      if (createMore && !editing) titleRef.current?.focus()
      else onOpenChange(false)
    } finally {
      saveLock.current = false
      setSaving(false)
    }
  }
  function saveDraft() {
    try {
      const key = triageDraftKey(team.id)
      const previous = productStorage.getItem(key)
      if (previous) triageDraftSchema.parse(JSON.parse(previous))
      productStorage.setItem(
        key,
        JSON.stringify(triageDraftSchema.parse(draft))
      )
      onError(null)
      onOpenChange(false)
    } catch {
      onError(
        "Your draft could not be saved. Keep this window open and try again. Existing saved data has been preserved."
      )
    }
  }
  async function attach(files: Array<File>) {
    const existing = draft.attachments ?? []
    const existingBytes = existing.reduce(
      (sum, file) => sum + file.data.length * 0.75,
      0
    )
    if (
      files.length + existing.length > 5 ||
      files.reduce((sum, file) => sum + file.size, existingBytes) > 2_000_000
    ) {
      onError("Choose up to 5 attachments, totaling no more than 2 MB.")
      return
    }
    setAttaching(true)
    try {
      const attachments = await Promise.all(
        files.map(
          (file) =>
            new Promise<{ name: string; data: string }>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () =>
                resolve({ name: file.name, data: String(reader.result) })
              reader.onerror = () => reject(new Error("File could not be read"))
              reader.readAsDataURL(file)
            })
        )
      )
      onDraftChange({
        ...draftRef.current,
        attachments: [...(draftRef.current.attachments ?? []), ...attachments],
      })
      onError(null)
    } catch {
      onError("The attachment could not be read. Please try again.")
    } finally {
      setAttaching(false)
    }
  }
  const templates =
    directory?.templates.filter(
      (item) =>
        item.payload.kind === "issue" && item.payload.issueType === "standard"
    ) ?? []
  const directoryMessage = directoryError
    ? "Could not load team templates and members. Close and reopen to retry."
    : "Loading…"
  const assignee =
    directory?.members.find((member) => member.id === draft.assignee)?.name ??
    draft.assignee
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-black/50 supports-backdrop-filter:backdrop-blur-none"
        initialFocus={titleRef}
        className={cn(
          "top-[18vh] max-h-[calc(82dvh-1rem)] -translate-y-0 gap-0 overflow-y-auto rounded-[22px] p-3 sm:max-w-[750px]",
          expanded && "top-[8vh] max-h-[84dvh] sm:max-w-[960px]"
        )}
      >
        <DialogTitle className="sr-only">
          {editing ? "Edit triage issue" : "Create issue"}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {team.name} triage issue. Enter a title and description, then choose
          properties.
        </DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault()
              submit()
            }
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              <Property
                label="Team"
                content={
                  <p className="text-xs text-muted-foreground">
                    This issue will be created in {team.name}’s triage.
                  </p>
                }
              >
                <TeamSidebarIcon
                  icon={team.icon}
                  name={team.name}
                  className="size-3.5"
                />
                <span>{team.identifier}</span>
              </Property>
              <span aria-hidden="true" className="px-0.5 text-muted-foreground">
                ›
              </span>
              <Popover open={templateOpen} onOpenChange={setTemplateOpen}>
                <PopoverTrigger
                  render={
                    <Button
                      size="sm"
                      type="button"
                      variant="secondary"
                      className={chip}
                      aria-label="Apply template"
                    />
                  }
                >
                  <Glyph name="document" />
                  <span className="truncate">
                    {draft.templateName || "Template"}
                  </span>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="max-h-72 w-64 gap-1 overflow-y-auto rounded-xl p-2"
                >
                  {!directory ? (
                    <p className="p-2 text-xs text-muted-foreground">
                      {directoryMessage}
                    </p>
                  ) : templates.length ? (
                    templates.map((template) => (
                      <Button
                        key={template.id}
                        type="button"
                        variant="ghost"
                        className="justify-start text-xs"
                        onClick={() => {
                          const value = template.payload
                          update({
                            title: value.title || draft.title,
                            description: value.content
                              ? documentText(value.content).slice(0, 10000)
                              : value.description,
                            priority: value.properties.priority,
                            assignee: value.properties.assignee ?? "",
                            project: value.properties.project ?? "",
                            labels: value.properties.labels
                              .join(", ")
                              .slice(0, 1000),
                            templateName: value.name,
                          })
                          setTemplateOpen(false)
                        }}
                      >
                        {template.payload.name}
                      </Button>
                    ))
                  ) : (
                    <p className="p-2 text-xs text-muted-foreground">
                      No issue templates for this team yet.
                    </p>
                  )}
                </PopoverContent>
              </Popover>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {!editing && (
                <Button
                  size="sm"
                  type="button"
                  variant="secondary"
                  className={chip}
                  onClick={saveDraft}
                  disabled={attaching || saving}
                >
                  Save as draft
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={expanded ? "Collapse" : "Expand"}
                onClick={() => setExpanded(!expanded)}
              >
                <ExpandIcon expanded={expanded} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close"
                onClick={() => onOpenChange(false)}
              >
                <Glyph name="close" />
              </Button>
            </div>
          </div>
          <div className="mt-4 space-y-2">
            <input
              ref={titleRef}
              aria-label="Issue title"
              placeholder="Issue title"
              maxLength={240}
              required
              value={draft.title}
              onChange={(event) => update({ title: event.target.value })}
              className={cn(field, "h-8 text-lg font-medium")}
            />
            <textarea
              aria-label="Description"
              placeholder="Add description…"
              maxLength={10000}
              value={draft.description}
              onChange={(event) => update({ description: event.target.value })}
              className={cn(
                field,
                "min-h-16 resize-none py-1 text-sm",
                expanded && "min-h-64"
              )}
            />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-1.5">
            <Property
              label="Status: Triage"
              content={
                <p className="text-xs text-muted-foreground">
                  New issues enter Triage for review.
                </p>
              }
            >
              <span
                aria-hidden="true"
                className="flex size-3.5 items-center justify-center rounded-full bg-orange-500 text-[10px] font-bold text-black"
              >
                ↔
              </span>
              Triage
            </Property>
            <Property
              label="Change priority"
              content={
                <label className="space-y-2 text-xs">
                  Priority
                  <OptionSelect
                    aria-label="Priority"
                    value={draft.priority}
                    onValueChange={(nextValue) =>
                      update({
                        priority: nextValue as TriageDraft["priority"],
                      })
                    }
                    className="mt-2 h-8 w-full rounded-lg border bg-background px-2"
                  >
                    {triagePriorities.map((priority) => (
                      <option key={priority}>{priority}</option>
                    ))}
                  </OptionSelect>
                </label>
              }
            >
              <Glyph name="priority" />
              <span className="truncate">
                {draft.priority === "No priority" ? "Priority" : draft.priority}
              </span>
            </Property>
            <Property
              label="Change assignee"
              content={
                !directory ? (
                  <p className="text-xs text-muted-foreground">
                    {directoryMessage}
                  </p>
                ) : (
                  <label className="text-xs">
                    Assignee
                    <OptionSelect
                      aria-label="Assignee"
                      value={draft.assignee ?? ""}
                      onValueChange={(nextValue) =>
                        update({ assignee: nextValue })
                      }
                      className="mt-2 h-8 w-full rounded-lg border bg-background px-2"
                    >
                      <option value="">No assignee</option>
                      {directory.members.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.name}
                        </option>
                      ))}
                    </OptionSelect>
                  </label>
                )
              }
            >
              <Glyph name="person" />
              <span className="truncate">{assignee || "Assignee"}</span>
            </Property>
            <Property
              label="Change project"
              content={
                <label className="space-y-2 text-xs">
                  Project
                  <Input
                    aria-label="Project"
                    value={draft.project ?? ""}
                    maxLength={200}
                    placeholder="Project name"
                    onChange={(event) =>
                      update({ project: event.target.value })
                    }
                  />
                </label>
              }
            >
              <Glyph name="project" />
              <span className="truncate">{draft.project || "Project"}</span>
            </Property>
            <Property
              label="Change labels"
              content={
                <label className="space-y-2 text-xs">
                  Labels
                  <Input
                    aria-label="Labels"
                    value={draft.labels ?? ""}
                    maxLength={1000}
                    placeholder="Labels, separated by commas"
                    onChange={(event) => update({ labels: event.target.value })}
                  />
                </label>
              }
            >
              <Glyph name="label" />
              <span className="truncate">{draft.labels || "Labels"}</span>
            </Property>
            <Property
              label="Add to cycle"
              content={
                <p className="text-xs text-muted-foreground">
                  Cycle assignment is not available in this composer.
                </p>
              }
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="6" />
                <path d="m6 5 4 3-4 3z" />
              </svg>
            </Property>
            <Property
              label="More actions"
              content={
                <label className="space-y-2 text-xs">
                  Due date
                  <Input
                    type="date"
                    aria-label="Due date"
                    value={draft.dueDate}
                    onChange={(event) =>
                      update({ dueDate: event.target.value })
                    }
                  />
                </label>
              }
            >
              <Glyph name="more" />
            </Property>
          </div>
          {!!draft.attachments?.length && (
            <ul className="mt-3 flex flex-wrap gap-2">
              {draft.attachments.map((file, index) => (
                <li
                  key={`${file.name}-${index}`}
                  className="flex max-w-full items-center gap-1 rounded-lg bg-muted px-2 text-xs"
                >
                  <span className="truncate">{file.name}</span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${file.name}`}
                    onClick={() =>
                      update({
                        attachments: draft.attachments?.filter(
                          (_, i) => i !== index
                        ),
                      })
                    }
                  >
                    <Glyph name="close" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="mt-6 flex items-center justify-between gap-3">
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              aria-label="Issue attachments"
              onChange={(event) => {
                void attach(Array.from(event.target.files ?? []))
                event.target.value = ""
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="icon-sm"
              aria-label="Attach images, files, or videos"
              disabled={attaching || saving}
              onClick={() => fileRef.current?.click()}
            >
              <Glyph name="dependency" />
            </Button>
            <div className="flex items-center gap-3">
              {!editing && (
                <div className="flex items-center gap-1.5">
                  <Switch
                    size="sm"
                    aria-label="Create more"
                    checked={createMore}
                    onCheckedChange={setCreateMore}
                  />
                  <span className="text-xs text-muted-foreground">
                    Create more
                  </span>
                </div>
              )}
              <Button
                type="submit"
                size="sm"
                disabled={!draft.title.trim() || attaching}
                className="rounded-full bg-[#646bda] px-3 text-xs text-white hover:bg-[#737be5]"
              >
                {attaching
                  ? "Attaching…"
                  : editing
                    ? "Save issue"
                    : "Create issue"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
