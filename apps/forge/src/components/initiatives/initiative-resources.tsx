import { useState } from "react"
import { initiativePrimary } from "./initiative-properties"
import type { Initiative } from "@/lib/initiatives"
import { RichEditor } from "@/components/templates/rich-editor"
import { IssueIcon } from "@/components/issues/issue-controls"
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
import { cn } from "@/lib/utils"

type Resource = Initiative["resources"][number]
export function InitiativeResources({
  item,
  writable,
  onSave,
  onRemove,
}: {
  item: Initiative
  writable: boolean
  onSave: (resource: Resource) => boolean
  onRemove: (id: string) => void
}) {
  const [draft, setDraft] = useState<Resource | null>(null)
  const [kind, setKind] = useState<"document" | "link">("link")
  const [error, setError] = useState("")
  function open(resource?: Resource) {
    setDraft(
      resource ?? { id: crypto.randomUUID(), title: "", url: "", body: null }
    )
    setKind(resource ? (resource.url ? "link" : "document") : "link")
    setError("")
  }
  function save() {
    if (!draft?.title.trim()) return
    if (kind === "link") {
      try {
        const url = new URL(draft.url ?? "")
        if (!["http:", "https:"].includes(url.protocol)) throw new Error()
      } catch {
        setError("Enter a valid http or https URL.")
        return
      }
    }
    const resource = {
      ...draft,
      title: draft.title.trim(),
      url: kind === "link" ? new URL(draft.url ?? "").href : undefined,
      body: kind === "document" ? draft.body : null,
    }
    if (onSave(resource)) setDraft(null)
    else setError("The resource could not be saved. Your draft has been kept.")
  }
  return (
    <div className="mt-3 flex flex-wrap items-start gap-x-4 gap-y-2 text-[13px]">
      <h2 className="w-16 shrink-0 pt-1 text-xs font-normal text-muted-foreground">
        Resources
      </h2>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {item.resources.map((resource) => (
          <div
            key={resource.id}
            className="flex max-w-full items-center gap-0.5 rounded-md border border-border/40 px-1 text-xs"
          >
            {resource.url ? (
              <a
                href={resource.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-1.5 px-1 py-1.5"
              >
                <IssueIcon name="link" />
                <span className="truncate">{resource.title}</span>
              </a>
            ) : (
              <Button variant="ghost" size="xs" onClick={() => open(resource)}>
                <IssueIcon name="file" />
                <span className="truncate">{resource.title}</span>
              </Button>
            )}
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
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={!writable}
                  onClick={() => open(resource)}
                >
                  Edit resource
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!writable}
                  onClick={() => onRemove(resource.id)}
                >
                  Remove resource
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
        <Button
          variant="ghost"
          size="xs"
          className="px-0 text-xs text-muted-foreground"
          disabled={!writable}
          onClick={() => open()}
        >
          <IssueIcon name="add" />
          Add document or link…
        </Button>
      </div>
      <Dialog
        open={Boolean(draft)}
        onOpenChange={(value) => {
          if (!value) setDraft(null)
        }}
      >
        <DialogContent
          className={cn(
            "max-w-lg",
            kind === "document" &&
              "max-h-[85dvh] max-w-[800px]! overflow-y-auto"
          )}
        >
          <DialogHeader>
            <DialogTitle>
              {item.resources.some((value) => value.id === draft?.id)
                ? "Edit resource"
                : "Add a resource"}
            </DialogTitle>
            <DialogDescription>
              Keep related documents and links with this initiative.
            </DialogDescription>
          </DialogHeader>
          <div role="tablist" aria-label="Resource type" className="flex gap-1">
            {(["link", "document"] as const).map((value) => (
              <Button
                key={value}
                role="tab"
                aria-selected={kind === value}
                variant={kind === value ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setKind(value)}
              >
                {value === "link" ? "Link" : "Document"}
              </Button>
            ))}
          </div>
          <Input
            autoFocus
            aria-label="Resource title"
            placeholder={kind === "link" ? "Link title" : "Document title"}
            value={draft?.title ?? ""}
            maxLength={200}
            disabled={!writable}
            onChange={(event) =>
              setDraft((current) =>
                current ? { ...current, title: event.target.value } : null
              )
            }
          />
          {kind === "link" ? (
            <Input
              aria-label="Resource URL"
              placeholder="https://…"
              value={draft?.url ?? ""}
              disabled={!writable}
              onChange={(event) =>
                setDraft((current) =>
                  current ? { ...current, url: event.target.value } : null
                )
              }
            />
          ) : (
            <RichEditor
              key={draft?.id}
              label="Resource document content"
              value={draft?.body ?? null}
              editable={writable}
              onChange={(body) =>
                setDraft((current) =>
                  current
                    ? { ...current, body: body as Resource["body"] }
                    : null
                )
              }
              placeholder="Start writing…"
              className="min-h-48"
            />
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button
              className={initiativePrimary}
              disabled={!writable || !draft?.title.trim()}
              onClick={save}
            >
              Save resource
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
