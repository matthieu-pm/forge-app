import { useRef, useState } from "react"
import { useBlocker } from "@tanstack/react-router"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight01Icon } from "@hugeicons/core-free-icons"
import type { InitiativeProject } from "@/lib/initiatives"
import type { ProjectResource } from "@/lib/project-resources"
import { defaultDocumentIcon } from "@/lib/team-documents"
import { DocumentContent } from "@/components/documents/document-content"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { IssueIcon } from "@/components/issues/issue-controls"
import { Button } from "@/components/ui/button"
import { ContentHeader } from "@/components/ui/content-header"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

export function ProjectDocumentEditor({
  project,
  resource,
  writable,
  onSave,
  onBack,
  onRemove,
}: {
  project: InitiativeProject
  resource: ProjectResource
  writable: boolean
  onSave: (resource: ProjectResource) => boolean
  onBack: () => void
  onRemove: () => boolean
}) {
  const [draft, setDraft] = useState(resource)
  const current = useRef(resource)
  const initialBody = useRef(
    resource.body ?? { type: "doc", content: [{ type: "paragraph" }] }
  )
  const [title, setTitle] = useState(
    resource.title === "New document" ? "" : resource.title
  )
  const [error, setError] = useState("")
  const [wide, setWide] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState("")
  const blocker = useBlocker({
    shouldBlockFn: () => Boolean(error),
    enableBeforeUnload: () => Boolean(error),
    withResolver: true,
  })

  function save(changes: Partial<ProjectResource> = {}) {
    if (!writable) return false
    const next = {
      ...current.current,
      ...changes,
      ...(["title", "body", "icon"].some((key) => key in changes)
        ? { updatedAt: new Date().toISOString() }
        : {}),
    }
    current.current = next
    setDraft(next)
    const saved = onSave(next)
    setError(
      saved
        ? ""
        : "Your changes could not be saved on this device. Keep this page open and try again."
    )
    return saved
  }
  async function copyUrl() {
    try {
      const url = new URL(window.location.href)
      url.searchParams.set("document", resource.id)
      await navigator.clipboard.writeText(url.href)
      toast.success("Document URL copied")
    } catch {
      toast.error("The document URL could not be copied")
    }
  }
  function back() {
    if (!error || save()) onBack()
  }

  return (
    <section
      aria-label="Project document editor"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <ContentHeader>
        <button
          type="button"
          onClick={back}
          className="inline-flex min-w-0 items-center gap-2 rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Back to ${project.name}`}
        >
          <TeamSidebarIcon
            name={project.name}
            icon={
              project.icon ?? {
                kind: "icon",
                value: "CubeIcon",
                color: "#5e6ad2",
              }
            }
          />
          <span className="max-w-40 truncate sm:max-w-64">{project.name}</span>
        </button>
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={1.7}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <TeamSidebarIcon
          name={draft.title}
          icon={draft.icon ?? defaultDocumentIcon}
          className="hidden size-4 sm:block"
        />
        <span className="min-w-0 truncate">{draft.title}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={
            draft.favorite
              ? "Remove document from favorites"
              : "Add document to favorites"
          }
          aria-pressed={Boolean(draft.favorite)}
          disabled={!writable}
          onClick={() => save({ favorite: !draft.favorite })}
          className={cn(
            "text-muted-foreground",
            draft.favorite && "text-yellow-500"
          )}
        >
          <IssueIcon name="star" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Document options"
              >
                <IssueIcon name="more" />
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="w-48">
            <DropdownMenuItem onClick={copyUrl}>
              <IssueIcon name="link" />
              Copy document URL
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={!writable || Boolean(error)}
              onClick={() => {
                setDeleteError("")
                setDeleting(true)
              }}
            >
              <IssueIcon name="delete" />
              Delete document
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Document display options and metadata"
                  className="text-xs font-normal text-muted-foreground"
                >
                  <IssueIcon name="settings" />
                  <span className="hidden md:inline">
                    {draft.updatedAt
                      ? `Edited ${new Date(draft.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
                      : "Document details"}
                  </span>
                </Button>
              }
            />
            <PopoverContent align="end" className="w-64 gap-4 text-xs">
              <label className="flex items-center justify-between gap-3">
                Full width
                <input
                  type="checkbox"
                  checked={wide}
                  onChange={(event) => setWide(event.target.checked)}
                  className="accent-primary"
                />
              </label>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 border-t border-border/50 pt-4 text-muted-foreground">
                <dt>Created</dt>
                <dd>
                  {draft.createdAt
                    ? new Date(draft.createdAt).toLocaleString()
                    : "—"}
                </dd>
                <dt>Last edited</dt>
                <dd>
                  {draft.updatedAt
                    ? new Date(draft.updatedAt).toLocaleString()
                    : "—"}
                </dd>
              </dl>
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Copy document URL"
            onClick={copyUrl}
          >
            <IssueIcon name="link" />
          </Button>
        </div>
      </ContentHeader>
      {error && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive"
        >
          <span className="flex-1">{error}</span>
          <Button variant="ghost" size="sm" onClick={() => save()}>
            Try again
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DocumentContent
          autoFocus
          editable={writable}
          wide={wide}
          title={title}
          body={initialBody.current}
          icon={draft.icon ?? defaultDocumentIcon}
          onIconChange={(icon) => save({ icon })}
          onTitleChange={(value) => {
            setTitle(value)
            save({ title: value.trim() || "New document" })
          }}
          onBodyChange={(body) =>
            save({ body: body as ProjectResource["body"] })
          }
        />
      </div>
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete document?</DialogTitle>
            <DialogDescription>
              This removes “{draft.title}” and its content from the project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (onRemove()) onBack()
                else
                  setDeleteError(
                    "The document could not be deleted. Please try again."
                  )
              }}
            >
              Delete document
            </Button>
          </DialogFooter>
          {deleteError && (
            <p role="alert" className="text-xs text-destructive">
              {deleteError}
            </p>
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave without saving?</DialogTitle>
            <DialogDescription>
              Your latest changes could not be saved. Stay here to retry, or
              leave and discard those changes.
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
    </section>
  )
}
