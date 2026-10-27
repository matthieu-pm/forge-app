import { useRef, useState } from "react"
import type { ProjectResource } from "@/lib/project-resources"
import { newResourceDocument } from "@/lib/project-resources"
import { RichEditor } from "@/components/templates/rich-editor"
import { IssueIcon } from "@/components/issues/issue-controls"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
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
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function InitiativeResources({
  item,
  writable,
  onSave,
  onRemove,
  onOpenDocument,
  context = "initiative",
}: {
  item: { resources: Array<ProjectResource> }
  writable: boolean
  onSave: (resource: ProjectResource) => boolean
  onRemove: (id: string) => boolean | void
  onOpenDocument?: (id: string) => void
  context?: "initiative" | "project"
}) {
  const [draft, setDraft] = useState<ProjectResource | null>(null)
  const [kind, setKind] = useState<"document" | "link">("link")
  const [error, setError] = useState("")
  const [menuOpen, setMenuOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const editing = item.resources.some((resource) => resource.id === draft?.id)

  function openLink(resource?: ProjectResource) {
    setKind("link")
    setError("")
    setDraft(resource ?? { id: crypto.randomUUID(), title: "", url: "" })
  }
  function openDocument(resource?: ProjectResource) {
    if (!resource && !writable) return
    setError("")
    if (onOpenDocument) {
      const document = resource ?? newResourceDocument()
      if (resource || onSave(document)) onOpenDocument(document.id)
      else setError("The document could not be created. Please try again.")
      return
    }
    setKind("document")
    setDraft(resource ?? newResourceDocument())
  }
  function save() {
    if (!draft || !writable) return
    let url: string | undefined
    if (kind === "link") {
      try {
        const parsed = new URL(draft.url?.trim() ?? "")
        if (!["http:", "https:"].includes(parsed.protocol)) throw new Error()
        url = parsed.href
      } catch {
        setError("Enter a valid http or https URL.")
        return
      }
    }
    const now = new Date().toISOString()
    const resource = {
      ...draft,
      title: draft.title.trim() || (url?.slice(0, 200) ?? "New document"),
      url,
      body: kind === "document" ? draft.body : null,
      createdAt: draft.createdAt ?? now,
      updatedAt: now,
    }
    if (onSave(resource)) {
      setDraft(null)
      setError("")
    } else
      setError("The resource could not be saved. Your draft has been kept.")
  }

  return (
    <div className="mt-3 grid grid-cols-[64px_minmax(0,1fr)] items-start gap-x-4 text-[13px]">
      <h2 className="flex h-7 items-center text-xs font-normal text-muted-foreground">
        Resources
      </h2>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {item.resources.map((resource) => (
          <div
            key={resource.id}
            className="flex h-7 max-w-full items-center gap-0.5 rounded-full border border-border/40 px-1 text-xs"
          >
            {resource.url ? (
              <a
                href={resource.url}
                target="_blank"
                rel="noreferrer"
                className="flex h-full min-w-0 items-center gap-1.5 rounded-full px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <IssueIcon name="link" />
                <span className="truncate">{resource.title}</span>
              </a>
            ) : (
              <Button
                variant="ghost"
                size="xs"
                className="px-1"
                onClick={() => openDocument(resource)}
              >
                <IssueIcon name="file" />
                <span className="truncate">{resource.title}</span>
              </Button>
            )}
            {writable && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Resource options for ${resource.title}`}
                    >
                      <IssueIcon name="more" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem
                    onClick={() =>
                      resource.url ? openLink(resource) : openDocument(resource)
                    }
                  >
                    {resource.url ? "Edit link" : "Open document"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => {
                      if (onRemove(resource.id) === false)
                        setError(
                          "The resource could not be removed. Please try again."
                        )
                    }}
                  >
                    Remove resource
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        ))}
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            render={
              <Button
                ref={trigger}
                variant="ghost"
                size="sm"
                className="px-2 text-xs font-normal text-muted-foreground"
                disabled={!writable}
              >
                <IssueIcon name="add" />
                Add document or link…
              </Button>
            }
          />
          <DropdownMenuContent
            align="start"
            className="w-60"
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key.toLowerCase() === "l"
              ) {
                event.preventDefault()
                setMenuOpen(false)
                openLink()
              }
            }}
          >
            <DropdownMenuItem onClick={() => openDocument()}>
              <IssueIcon name="file" />
              Create new document…
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openLink()}>
              <IssueIcon name="link" />
              Add a link…
              <DropdownMenuShortcut>Ctrl L</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {error && !draft && (
          <p role="alert" className="w-full text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <Dialog
        open={Boolean(draft)}
        onOpenChange={(open) => {
          if (!open) {
            setDraft(null)
            setError("")
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className={
            kind === "document"
              ? "max-h-[85dvh] overflow-y-auto sm:max-w-[800px]"
              : "gap-6 sm:max-w-[560px]"
          }
          finalFocus={trigger}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <IssueIcon name={kind === "link" ? "link" : "file"} />
              {kind === "link"
                ? editing
                  ? "Edit link"
                  : `Add link to ${context}`
                : editing
                  ? "Edit document"
                  : "New document"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {kind === "link"
                ? "Enter a URL and an optional title."
                : "Write a document for this initiative."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-6"
            onSubmit={(event) => {
              event.preventDefault()
              save()
            }}
            noValidate
          >
            {kind === "link" && (
              <div className="grid gap-2">
                <Label htmlFor={`resource-url-${draft?.id}`}>URL</Label>
                <Input
                  id={`resource-url-${draft?.id}`}
                  autoFocus
                  aria-label="URL"
                  placeholder="https://…"
                  value={draft?.url ?? ""}
                  disabled={!writable}
                  aria-invalid={Boolean(error)}
                  aria-describedby={
                    error ? `resource-error-${draft?.id}` : undefined
                  }
                  onChange={(event) => {
                    setError("")
                    setDraft((current) =>
                      current ? { ...current, url: event.target.value } : null
                    )
                  }}
                />
              </div>
            )}
            <div className="grid gap-2">
              <Label htmlFor={`resource-title-${draft?.id}`}>
                {kind === "link" ? "Title (optional)" : "Document title"}
              </Label>
              <Input
                id={`resource-title-${draft?.id}`}
                aria-label={
                  kind === "link" ? "Title (optional)" : "Document title"
                }
                value={draft?.title ?? ""}
                maxLength={200}
                disabled={!writable}
                onChange={(event) =>
                  setDraft((current) =>
                    current ? { ...current, title: event.target.value } : null
                  )
                }
              />
            </div>
            {kind === "document" && (
              <RichEditor
                key={draft?.id}
                label="Resource document content"
                value={draft?.body ?? null}
                editable={writable}
                onChange={(body) =>
                  setDraft((current) =>
                    current
                      ? { ...current, body: body as ProjectResource["body"] }
                      : null
                  )
                }
                placeholder="Start writing…"
                className="min-h-48"
              />
            )}
            {error && (
              <p
                id={`resource-error-${draft?.id}`}
                role="alert"
                className="text-xs text-destructive"
              >
                {error}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setDraft(null)
                  setError("")
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!writable || (kind === "link" && !draft?.url?.trim())}
              >
                {kind === "link"
                  ? editing
                    ? "Save link"
                    : "Add link"
                  : "Save document"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
