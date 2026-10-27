import * as React from "react"
import { Link, useBlocker } from "@tanstack/react-router"
import { toast } from "sonner"
import {
  ArrowRight01Icon,
  Delete02Icon,
  Link01Icon,
  MoreHorizontalIcon,
  Settings03Icon,
  StarIcon,
} from "@hugeicons/core-free-icons"
import { DocumentContent } from "./documents/document-content"
import { HomeIcon, HomeIconButton } from "./team-home"
import { TeamSidebarIcon } from "./team-sidebar-icon"
import type { JSONContent } from "@tiptap/core"
import type { TeamSummary } from "@/lib/team-contract"
import type { HomeStore, TeamResource } from "@/lib/team-home-state"
import { ContentHeader } from "@/components/ui/content-header"
import {
  defaultDocumentIcon,
  documentPlainText,
  teamDocumentBody,
} from "@/lib/team-documents"
import { Button } from "@/components/ui/button"
import { OptionSelect } from "@/components/ui/option-select"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { cn } from "@/lib/utils"

export function TeamDocumentEditor({
  team,
  resource,
  store,
  onBack,
  onDelete,
}: {
  team: TeamSummary
  resource: TeamResource
  store: HomeStore
  onBack: () => void
  onDelete: () => void
}) {
  const [draft, setDraft] = React.useState(resource)
  const [title, setTitle] = React.useState(
    resource.title === "New document" ? "" : resource.title
  )
  const [error, setError] = React.useState("")
  const [wide, setWide] = React.useState(false)
  const initialBody = React.useRef(teamDocumentBody(resource))
  const pending = React.useRef<Partial<TeamResource>>({})
  const blocker = useBlocker({
    shouldBlockFn: () => Boolean(error),
    enableBeforeUnload: () => Boolean(error),
    withResolver: true,
  })
  React.useEffect(() => {
    setDraft({ ...resource, ...pending.current })
  }, [resource])

  function save(changes: Partial<TeamResource> = {}) {
    const patch = {
      ...pending.current,
      ...changes,
      ...(["title", "content", "body", "icon"].some((key) => key in changes)
        ? { updatedAt: new Date().toISOString() }
        : {}),
    }
    pending.current = patch
    setDraft((current) => ({ ...current, ...patch }))
    if (
      !store.state.resources.some((item) => item.id === resource.id) ||
      !store.update((current) => ({
        ...current,
        resources: current.resources.map((item) =>
          item.id === resource.id ? { ...item, ...patch } : item
        ),
      }))
    ) {
      setError(
        "Your changes could not be saved on this device. Keep this page open and try again."
      )
      return false
    }
    pending.current = {}
    setError("")
    return true
  }
  function updateBody(body: JSONContent) {
    save({
      body: body as TeamResource["body"],
      content: documentPlainText(body),
    })
  }
  async function copyUrl() {
    try {
      const url = new URL(
        `/teams/${encodeURIComponent(team.slug)}/documents`,
        window.location.origin
      )
      url.searchParams.set("document", resource.id)
      await navigator.clipboard.writeText(url.href)
      toast.success("Document URL copied")
    } catch {
      toast.error("The document URL could not be copied")
    }
  }

  return (
    <section
      aria-label="Document editor"
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <ContentHeader>
        <Link
          to="/teams/$teamSlug/overview"
          params={{ teamSlug: team.slug }}
          className="hidden shrink-0 items-center gap-2 rounded hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
        >
          <TeamSidebarIcon
            icon={team.icon}
            name={team.name}
            className="size-4"
          />
          {team.name}
        </Link>
        <HomeIcon
          icon={ArrowRight01Icon}
          className="hidden size-3 text-muted-foreground sm:block"
        />
        <button
          onClick={() => {
            if (!error) onBack()
          }}
          className="shrink-0 rounded text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          Documents
        </button>
        <HomeIcon
          icon={ArrowRight01Icon}
          className="size-3 text-muted-foreground"
        />
        <TeamSidebarIcon
          icon={draft.icon ?? defaultDocumentIcon}
          name={draft.title}
          className="hidden size-4 text-muted-foreground md:block"
        />
        <span className="min-w-0 truncate">{draft.title}</span>
        <HomeIconButton
          label={
            draft.favorite
              ? "Remove document from favorites"
              : "Add document to favorites"
          }
          icon={StarIcon}
          aria-pressed={Boolean(draft.favorite)}
          className={cn(
            "shrink-0 text-muted-foreground",
            draft.favorite && "text-yellow-500"
          )}
          onClick={() => save({ favorite: !draft.favorite })}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <HomeIconButton
                label="Document options"
                icon={MoreHorizontalIcon}
              />
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onClick={copyUrl}>
              <HomeIcon icon={Link01Icon} />
              Copy document URL
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <div className="px-2 py-2">
              <label className="flex flex-col gap-2 text-xs text-muted-foreground">
                Section
                <OptionSelect
                  aria-label="Document section"
                  value={draft.sectionId ?? ""}
                  onValueChange={(value) => save({ sectionId: value || null })}
                >
                  <option value="">Team documents</option>
                  {store.state.sections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {section.name}
                    </option>
                  ))}
                </OptionSelect>
              </label>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={Boolean(error)}
              onClick={onDelete}
            >
              <HomeIcon icon={Delete02Icon} />
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
                  className="gap-1.5 px-2 text-xs text-muted-foreground"
                >
                  <HomeIcon icon={Settings03Icon} />
                  <span className="hidden lg:inline">
                    Edited{" "}
                    {new Date(draft.updatedAt).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
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
                  {resource.createdAt
                    ? new Date(resource.createdAt).toLocaleString()
                    : "—"}
                </dd>
                <dt>Last edited</dt>
                <dd>{new Date(draft.updatedAt).toLocaleString()}</dd>
                <dt>Owner</dt>
                <dd className="truncate">{draft.owner?.name ?? "—"}</dd>
              </dl>
            </PopoverContent>
          </Popover>
          <HomeIconButton
            label="Copy document URL"
            icon={Link01Icon}
            onClick={copyUrl}
          />
        </div>
      </ContentHeader>
      {(error || store.error) && (
        <div
          role="alert"
          className="flex items-center gap-3 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive"
        >
          <span className="flex-1">{error || store.error}</span>
          {error && (
            <Button size="sm" variant="ghost" onClick={() => save()}>
              Try again
            </Button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DocumentContent
          autoFocus
          wide={wide}
          title={title}
          body={initialBody.current}
          icon={draft.icon ?? defaultDocumentIcon}
          onIconChange={(icon) => save({ icon })}
          onTitleChange={(value) => {
            setTitle(value)
            save({ title: value.trim() || "New document" })
          }}
          onBodyChange={updateBody}
        />
      </div>
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
