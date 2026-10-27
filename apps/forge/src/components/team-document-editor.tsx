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
import { RichEditor } from "./templates/rich-editor"
import { HomeIcon, HomeIconButton } from "./team-home"
import { TeamIconPicker } from "./team-icon-picker"
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
        <article
          className={cn(
            "mx-auto w-full max-w-[888px] px-6 pt-16 pb-24 sm:px-10",
            wide && "max-w-none"
          )}
        >
          <TeamIconPicker
            label="Document icon"
            name={draft.title}
            value={draft.icon ?? defaultDocumentIcon}
            onChange={(icon) => save({ icon })}
            className="mb-2 size-9 rounded-lg border border-border/30 bg-transparent text-muted-foreground"
          />
          <input
            autoFocus
            aria-label="Document title"
            placeholder="New document"
            maxLength={200}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value)
              save({ title: event.target.value.trim() || "New document" })
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                event.currentTarget.parentElement
                  ?.querySelector<HTMLElement>(
                    '[aria-label="Document content"]'
                  )
                  ?.focus()
              }
            }}
            className="mb-7 h-10 w-full min-w-0 border-0 bg-transparent p-0 text-2xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/55"
          />
          <RichEditor
            value={initialBody.current}
            label="Document content"
            placeholder="Start writing..."
            className="min-h-[360px]"
            onChange={updateBody}
          />
        </article>
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
