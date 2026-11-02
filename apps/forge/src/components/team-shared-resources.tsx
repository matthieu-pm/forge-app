import * as React from "react"
import { useRouter } from "@tanstack/react-router"
import {
  Add01Icon,
  ArrowDown01Icon,
  File01Icon,
  FolderAddIcon,
  Link01Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import { Button } from "./ui/button"
import { Input } from "./ui/input"
import { OptionSelect } from "./ui/option-select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"
import { HomeIcon, HomeIconButton, homePill } from "./team-home"
import { useWorkspaceView } from "./account-preference-provider"
import type { HomeStore } from "@/lib/team-home-state"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamResourceFields } from "@/lib/team-resources-contract"
import { teamResourceUrl } from "@/lib/team-resources-contract"
import { useTeamResources } from "@/lib/team-resources-client"
import { productStorageIdentity } from "@/lib/product-storage"
import { useSharedDocuments } from "@/lib/shared-document-client"
import { downloadDocumentDraft } from "@/lib/document-download"

type PinnedLink = TeamResourceFields["links"][number]
function moved<T>(rows: Array<T>, index: number, delta: number) {
  const result = [...rows],
    target = index + delta
  if (target >= 0 && target < rows.length)
    [result[index], result[target]] = [result[target], result[index]]
  return result
}
export function TeamSharedResources({
  team,
  legacy,
}: {
  team: TeamSummary
  legacy: HomeStore
}) {
  const router = useRouter(),
    remote = useTeamResources(team.id),
    documents = useSharedDocuments({ kind: "team", id: team.id })
  const personal = useWorkspaceView("teamHome", team.id)
  const binding = productStorageIdentity()
  const identityScope = JSON.stringify([
    binding?.workspaceId,
    binding?.userId,
    binding?.sessionId,
  ])
  const board = remote.snapshot
  const [link, setLink] = React.useState<PinnedLink | null>(null),
    [section, setSection] = React.useState<{ id: string; name: string } | null>(
      null
    )
  const [formError, setFormError] = React.useState(""),
    [documentBusy, setDocumentBusy] = React.useState(false)
  React.useEffect(() => {
    setLink(null)
    setSection(null)
    setFormError("")
  }, [identityScope])
  const blocked =
    !remote.ready ||
    !!remote.error ||
    remote.saving ||
    !!remote.pending ||
    documentBusy
  const fields = (): TeamResourceFields => ({
    sections: board.sections,
    links: board.links,
    order: board.order,
  })
  async function save(next: TeamResourceFields) {
    try {
      if (!(await remote.save(next))) {
        setFormError(
          "Resources changed elsewhere. Your proposed changes are preserved below for review."
        )
        return false
      }
      setFormError("")
      return true
    } catch (e) {
      setFormError(
        e instanceof Error
          ? e.message
          : "Resources could not be saved. Retry the pending request."
      )
      return false
    }
  }
  function openDocument(id: string) {
    void router.navigate({
      to: "/teams/$teamSlug/documents",
      params: { teamSlug: team.slug },
      search: { document: id },
    })
  }
  async function createDocument(sectionId: string | null) {
    if (documentBusy) return
    setDocumentBusy(true)
    try {
      openDocument(await documents.create(sectionId))
    } catch (e) {
      toast.error(
        e instanceof Error ? e.message : "Document could not be created."
      )
    } finally {
      setDocumentBusy(false)
    }
  }
  function addMenu(sectionId: string | null) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" className={homePill} disabled={blocked}>
              <HomeIcon icon={Add01Icon} />
              Add resources
            </Button>
          }
        />
        <DropdownMenuContent>
          <DropdownMenuItem
            disabled={blocked || !documents.ready || !!documents.error}
            onClick={() => void createDocument(sectionId)}
          >
            New document
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={blocked}
            onClick={() => {
              setFormError("")
              setLink({
                id: crypto.randomUUID(),
                title: "",
                url: "",
                sectionId,
              })
            }}
          >
            New link…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  const ordered = [
    ...board.links.map((l) => ({
      key: `link:${l.id}`,
      id: l.id,
      title: l.title,
      sectionId: l.sectionId,
      link: l,
      document: null,
    })),
    ...documents.documents.map((d) => ({
      key: `document:${d.id}`,
      id: d.id,
      title: d.title,
      sectionId: d.sectionId,
      document: d,
      link: null,
    })),
  ].sort((a, b) => {
    const ai = board.order.indexOf(a.key),
      bi = board.order.indexOf(b.key)
    return (
      (ai < 0 ? 100000 : ai) - (bi < 0 ? 100000 : bi) ||
      (a.title === b.title
        ? a.key < b.key
          ? -1
          : a.key === b.key
            ? 0
            : 1
        : a.title < b.title
          ? -1
          : 1)
    )
  })
  function effectiveSection(sectionId: string | null) {
    return board.sections.some(
      (resourceSection) => resourceSection.id === sectionId
    )
      ? sectionId
      : null
  }
  function siblings(sectionId: string | null) {
    return ordered.filter(
      (resource) => effectiveSection(resource.sectionId) === sectionId
    )
  }
  async function reorderResource(key: string, delta: number) {
    const resource = ordered.find((row) => row.key === key)
    if (!resource) return
    const group = siblings(effectiveSection(resource.sectionId)),
      index = group.findIndex((row) => row.key === key)
    const target = group[index + delta]
    if (!target) return
    const order = ordered.map((row) => row.key),
      from = order.indexOf(key),
      to = order.indexOf(target.key)
    ;[order[from], order[to]] = [order[to], order[from]]
    await save({ ...fields(), order })
  }
  function resourceRows(sectionId: string | null) {
    return siblings(sectionId).map((resource) => (
      <div
        key={resource.key}
        data-resource-id={resource.key}
        className="group flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-muted/40"
      >
        <HomeIcon
          icon={resource.link ? Link01Icon : File01Icon}
          className="text-muted-foreground"
        />
        {resource.link && teamResourceUrl(resource.link.url) ? (
          <a
            className="min-w-0 flex-1 truncate text-sm focus-visible:ring-2 focus-visible:ring-ring"
            href={teamResourceUrl(resource.link.url)!}
            target="_blank"
            rel="noreferrer noopener"
          >
            {resource.title}
          </a>
        ) : (
          <button
            className="min-w-0 flex-1 truncate text-left text-sm focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => openDocument(resource.id)}
          >
            {resource.title}
          </button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <HomeIconButton
                label={`Actions for ${resource.title}`}
                icon={MoreHorizontalIcon}
                disabled={blocked}
              />
            }
          />
          <DropdownMenuContent>
            <DropdownMenuItem
              onClick={() =>
                resource.link
                  ? setLink(resource.link)
                  : openDocument(resource.id)
              }
            >
              {resource.link ? "Edit link" : "Open document / change section"}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={siblings(sectionId)[0]?.key === resource.key}
              onClick={() => void reorderResource(resource.key, -1)}
            >
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={siblings(sectionId).at(-1)?.key === resource.key}
              onClick={() => void reorderResource(resource.key, 1)}
            >
              Move down
            </DropdownMenuItem>
            {resource.link && (
              <DropdownMenuItem
                variant="destructive"
                onClick={() =>
                  void save({
                    ...fields(),
                    links: board.links.filter((l) => l.id !== resource.id),
                    order: board.order.filter((k) => k !== resource.key),
                  })
                }
              >
                Unpin link
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {resource.link && (
          <OptionSelect
            aria-label={`Section for ${resource.title}`}
            value={
              board.sections.some((s) => s.id === resource.sectionId)
                ? (resource.sectionId ?? "")
                : ""
            }
            disabled={blocked || !!documents.error}
            onValueChange={(value) => {
              void save({
                ...fields(),
                links: board.links.map((l) =>
                  l.id === resource.id ? { ...l, sectionId: value || null } : l
                ),
              })
            }}
            className="h-7 max-w-32 rounded-md bg-muted px-1 text-xs"
          >
            <option value="">Team resources</option>
            {board.sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </OptionSelect>
        )}
      </div>
    ))
  }
  function pendingControls() {
    if (!remote.pending) return null
    return (
      <div className="flex flex-wrap items-center gap-2">
        {" "}
        <Button
          type="button"
          variant="ghost"
          onClick={() => downloadDocumentDraft(remote.pending)}
        >
          Download proposed changes
        </Button>
        {remote.conflict ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              remote.reviewConflict()
              setFormError("")
              setLink(null)
              setSection(null)
            }}
          >
            Review latest resources
          </Button>
        ) : (
          <Button
            type="button"
            disabled={remote.saving}
            onClick={async () => {
              try {
                if (await remote.retry()) {
                  setFormError("")
                  setLink(null)
                  setSection(null)
                }
              } catch (e) {
                setFormError(
                  e instanceof Error
                    ? e.message
                    : "The request could not be confirmed."
                )
              }
            }}
          >
            Retry resource save
          </Button>
        )}
      </div>
    )
  }
  return (
    <section aria-label="Shared team resources" className="mt-9">
      <div className="flex items-center gap-2">
        <h2 className="mr-auto text-lg font-medium">Team resources</h2>
        {addMenu(null)}
        <HomeIconButton
          label="Add section"
          icon={FolderAddIcon}
          className={homePill}
          disabled={blocked}
          onClick={() => {
            setFormError("")
            setSection({ id: crypto.randomUUID(), name: "" })
          }}
        />
      </div>
      {!remote.ready && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Loading shared resources…
        </p>
      )}
      {remote.error && (
        <div role="alert" className="mt-3 text-sm">
          {remote.error}
          <Button variant="ghost" onClick={() => void remote.refresh()}>
            Try again
          </Button>
        </div>
      )}
      {remote.ready && !remote.error && formError && (
        <p role="alert" className="my-3 text-sm text-destructive">
          {formError}
        </p>
      )}
      {remote.pending && !remote.error && (
        <div
          className="my-3 rounded-lg border border-border p-3 text-sm"
          role="status"
        >
          <p>
            {remote.conflict
              ? "Your resource changes conflict with a newer version. Download your proposal before reviewing the latest shared resources."
              : "A resource save is awaiting confirmation. Retry the same request to safely confirm its outcome."}
          </p>
          {pendingControls()}
        </div>
      )}
      {remote.ready && !remote.error && (
        <>
          {ordered.length === 0 && board.sections.length === 0 && (
            <p className="mt-3 text-sm text-muted-foreground">
              Add shared documents and pin links. Create sections to organize
              them.
            </p>
          )}
          {documents.error && (
            <p role="alert" className="mt-3 text-sm">
              Documents could not be loaded.{" "}
              <Button variant="ghost" onClick={() => void documents.refresh()}>
                Retry documents
              </Button>
            </p>
          )}
          <div className="mt-3">{resourceRows(null)}</div>
          {board.sections.map((s, index) => {
            const collapsed = personal.value.collapsedSectionIds.includes(s.id)
            return (
              <section key={s.id} data-section-id={s.id} className="mt-5">
                <div className="flex items-center gap-2">
                  <button
                    aria-expanded={!collapsed}
                    className="flex h-7 items-center gap-1 rounded-full px-2 text-sm font-medium hover:bg-muted"
                    onClick={() =>
                      personal.save({
                        ...personal.value,
                        collapsedSectionIds: collapsed
                          ? personal.value.collapsedSectionIds.filter(
                              (id) => id !== s.id
                            )
                          : [...personal.value.collapsedSectionIds, s.id],
                      })
                    }
                  >
                    {s.name}
                    <HomeIcon
                      icon={ArrowDown01Icon}
                      className={collapsed ? "size-3 -rotate-90" : "size-3"}
                    />
                  </button>
                  <div className="h-px flex-1 bg-border/40" />
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <HomeIconButton
                          label={`Actions for ${s.name} section`}
                          icon={MoreHorizontalIcon}
                          disabled={blocked}
                        />
                      }
                    />
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        onClick={() => {
                          setFormError("")
                          setSection(s)
                        }}
                      >
                        Rename section
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === 0}
                        onClick={() =>
                          void save({
                            ...fields(),
                            sections: moved(board.sections, index, -1),
                          })
                        }
                      >
                        Move up
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={index === board.sections.length - 1}
                        onClick={() =>
                          void save({
                            ...fields(),
                            sections: moved(board.sections, index, 1),
                          })
                        }
                      >
                        Move down
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() =>
                          void save({
                            ...fields(),
                            sections: board.sections.filter(
                              (x) => x.id !== s.id
                            ),
                            links: board.links.map((l) =>
                              l.sectionId === s.id
                                ? { ...l, sectionId: null }
                                : l
                            ),
                          })
                        }
                      >
                        Delete section · keep resources
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {!collapsed && (
                  <div className="mt-2">
                    {resourceRows(s.id)}
                    {addMenu(s.id)}
                  </div>
                )}
              </section>
            )
          })}
          {(legacy.state.sections.length > 0 ||
            legacy.state.resources.some((r) => r.kind === "link")) && (
            <div className="mt-5 rounded-lg border border-border p-3 text-sm">
              <p>
                Earlier device-only sections and links are preserved. Review
                their backup before adding them to shared resources.
              </p>
              <Button
                variant="ghost"
                onClick={() =>
                  downloadDocumentDraft({
                    sections: legacy.state.sections,
                    links: legacy.state.resources.filter(
                      (r) => r.kind === "link"
                    ),
                  })
                }
              >
                Download legacy resource backup
              </Button>
            </div>
          )}
        </>
      )}
      {link && remote.ready && !remote.error && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setLink(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Pin team link</DialogTitle>
              <DialogDescription>
                Save a link for everyone with access to this team.
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={async (event) => {
                event.preventDefault()
                const url = teamResourceUrl(link.url)
                if (!url) {
                  setFormError(
                    "Enter a valid http or https URL without credentials."
                  )
                  return
                }
                if (
                  await save({
                    ...fields(),
                    links: [
                      ...board.links.filter((l) => l.id !== link.id),
                      { ...link, url },
                    ],
                  })
                )
                  setLink(null)
              }}
            >
              <Input
                autoFocus
                required
                aria-label="Resource title"
                placeholder="Link title"
                maxLength={200}
                value={link.title}
                onChange={(event) =>
                  setLink({ ...link, title: event.target.value })
                }
                disabled={blocked}
              />
              <Input
                required
                aria-label="URL"
                placeholder="https://"
                maxLength={4000}
                value={link.url}
                onChange={(event) =>
                  setLink({ ...link, url: event.target.value })
                }
                disabled={blocked}
              />
              <OptionSelect
                aria-label="Resource section"
                value={link.sectionId ?? ""}
                onValueChange={(value) =>
                  setLink({ ...link, sectionId: value || null })
                }
                disabled={blocked}
              >
                <option value="">Team resources</option>
                {board.sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </OptionSelect>
              {formError && (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              )}
              {pendingControls()}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setLink(null)}
                >
                  Close
                </Button>
                <Button type="submit" disabled={blocked || !link.title.trim()}>
                  Save link
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
      {section && remote.ready && !remote.error && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSection(null)
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {board.sections.some((s) => s.id === section.id)
                  ? "Rename section"
                  : "Add section"}
              </DialogTitle>
              <DialogDescription>
                Sections and their order are shared with this team.
              </DialogDescription>
            </DialogHeader>
            <form
              className="space-y-4"
              onSubmit={async (event) => {
                event.preventDefault()
                const exists = board.sections.some((s) => s.id === section.id)
                if (
                  await save({
                    ...fields(),
                    sections: exists
                      ? board.sections.map((s) =>
                          s.id === section.id ? section : s
                        )
                      : [...board.sections, section],
                  })
                )
                  setSection(null)
              }}
            >
              <Input
                autoFocus
                required
                aria-label="Section name"
                maxLength={80}
                value={section.name}
                onChange={(event) =>
                  setSection({ ...section, name: event.target.value })
                }
                disabled={blocked}
              />
              {formError && (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              )}
              {pendingControls()}
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setSection(null)}
                >
                  Close
                </Button>
                <Button
                  type="submit"
                  disabled={blocked || !section.name.trim()}
                >
                  Save section
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </section>
  )
}
