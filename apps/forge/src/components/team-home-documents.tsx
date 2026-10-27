import * as React from "react"
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  FilterHorizontalIcon,
  MoreHorizontalIcon,
  Settings03Icon,
} from "@hugeicons/core-free-icons"
import { TeamDocumentEditor } from "./team-document-editor"
import { TeamSidebarIcon } from "./team-sidebar-icon"
import type { TeamSummary } from "@/lib/team-contract"
import { authClient } from "@/lib/auth-client"
import {
  defaultDocumentIcon,
  documentTime,
  newTeamDocument,
} from "@/lib/team-documents"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { OptionSelect } from "@/components/ui/option-select"
import { useTeamHome } from "@/lib/team-home-state"
import {
  HomeIcon,
  HomeIconButton,
  TeamHomeLayout,
  homePill,
  homeSave,
} from "@/components/team-home"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function TeamDocuments({
  team,
  documentId,
  onOpenDocument,
}: {
  team: TeamSummary
  documentId?: string
  onOpenDocument?: (id?: string) => void
}) {
  const store = useTeamHome(team.id)
  const session = authClient.useSession()
  const [localDocumentId, setLocalDocumentId] = React.useState<string>()
  const [query, setQuery] = React.useState("")
  const [sort, setSort] = React.useState("name")
  const [ascending, setAscending] = React.useState(true)
  const [showDate, setShowDate] = React.useState(true)
  const [showOwner, setShowOwner] = React.useState(true)
  const [collapsed, setCollapsed] = React.useState(false)
  const activeId = onOpenDocument ? documentId : localDocumentId
  const documents = store.state.resources.filter((r) => r.kind === "document")
  const active = documents.find((resource) => resource.id === activeId)
  const visible = documents
    .filter((r) => r.title.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => {
      const left =
        sort === "name"
          ? a.title
          : sort === "owner"
            ? (a.owner?.name ?? "")
            : sort === "created"
              ? (a.createdAt ?? "")
              : a.updatedAt
      const right =
        sort === "name"
          ? b.title
          : sort === "owner"
            ? (b.owner?.name ?? "")
            : sort === "created"
              ? (b.createdAt ?? "")
              : b.updatedAt
      return (ascending ? 1 : -1) * left.localeCompare(right)
    })
  function openDocument(id?: string) {
    if (onOpenDocument) onOpenDocument(id)
    else setLocalDocumentId(id)
  }
  function create() {
    const user = session.data?.user
    const resource = newTeamDocument(
      user
        ? { id: user.id, name: user.name || "You", image: user.image }
        : undefined
    )
    if (
      homeSave(store, (state) => ({
        ...state,
        resources: [...state.resources, resource],
      }))
    )
      openDocument(resource.id)
  }
  function remove(id: string) {
    if (
      homeSave(
        store,
        (state) => ({
          ...state,
          resources: state.resources.filter((resource) => resource.id !== id),
        }),
        "Document deleted"
      ) &&
      activeId === id
    )
      openDocument()
  }
  function orderBy(value: string) {
    if (value === sort) setAscending(!ascending)
    else {
      setSort(value)
      setAscending(value === "name" || value === "owner")
    }
  }
  if (active && store.ready)
    return (
      <TeamDocumentEditor
        key={active.id}
        team={team}
        resource={active}
        store={store}
        onBack={() => openDocument()}
        onDelete={() => remove(active.id)}
      />
    )
  return (
    <TeamHomeLayout
      team={team}
      tab="documents"
      store={store}
      actions={
        <>
          <Button
            variant="outline"
            className={homePill}
            disabled={!store.ready || !!store.error}
            onClick={create}
          >
            <HomeIcon icon={Add01Icon} className="size-3" />
            New document
          </Button>
          <Popover>
            <PopoverTrigger
              render={
                <HomeIconButton
                  label="Add filter"
                  icon={FilterHorizontalIcon}
                  className={homePill}
                />
              }
            />
            <PopoverContent align="end" className="w-60">
              <label className="text-sm">
                Document title
                <Input
                  autoFocus
                  aria-label="Filter documents"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find documents…"
                  className="mt-2"
                />
              </label>
              {query && (
                <Button variant="ghost" onClick={() => setQuery("")}>
                  Clear filter
                </Button>
              )}
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger
              render={
                <HomeIconButton
                  label="Display options"
                  icon={Settings03Icon}
                  className={homePill}
                />
              }
            />
            <PopoverContent align="end" className="w-64">
              <label className="flex items-center justify-between text-sm">
                Ordering
                <OptionSelect
                  aria-label="Document ordering"
                  value={sort}
                  onValueChange={(nextValue) => {
                    setSort(nextValue)
                    setAscending(nextValue === "name" || nextValue === "owner")
                  }}
                  className="rounded-md bg-muted p-1"
                >
                  <option value="name">Name</option>
                  <option value="created">Created</option>
                  <option value="updated">Last edited</option>
                  <option value="owner">Owner</option>
                </OptionSelect>
              </label>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showDate}
                  onChange={(e) => setShowDate(e.target.checked)}
                />
                Created and last edited
              </label>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showOwner}
                  onChange={(event) => setShowOwner(event.target.checked)}
                />
                Owner
              </label>
            </PopoverContent>
          </Popover>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!store.ready ? (
          <p role="status" className="p-6 text-sm text-muted-foreground">
            Loading documents…
          </p>
        ) : activeId ? (
          <div role="status" className="p-8 text-sm text-muted-foreground">
            This document is no longer available.
            <Button
              variant="ghost"
              className="ml-2"
              onClick={() => openDocument()}
            >
              Back to documents
            </Button>
          </div>
        ) : documents.length === 0 ? (
          <div className="flex h-full min-h-[420px] items-center justify-center px-6 pb-12">
            <div className="w-[280px]">
              <svg
                aria-hidden="true"
                viewBox="0 0 96 100"
                className="mb-6 h-24 w-20 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                {[3, 2, 1, 0].map((i) => (
                  <g
                    key={i}
                    transform={`translate(${-i * 4} ${i * 5})`}
                    opacity={1 - i * 0.23}
                  >
                    <path
                      d="M30 8 61 12 77 26 81 75 Q81 81 75 80 L34 75 Q29 74 28 68 L25 14 Q24 7 30 8Z"
                      fill="var(--background)"
                    />
                    <path d="m38 30 29 4m-29 4 29 4m-28 4 29 4m-28 4 21 3" />
                  </g>
                ))}
              </svg>
              <h2 className="text-base font-medium">Team documents</h2>
              <p className="mt-2 text-sm leading-5 text-muted-foreground">
                Create documents to share notes, decisions, and plans with your
                team.
              </p>
              <Button
                onClick={create}
                disabled={!!store.error}
                size="sm"
                className="mt-4 rounded-full bg-[#5E6AD2] px-3 text-xs font-normal text-white hover:bg-[#5360C8]"
              >
                Create document
              </Button>
            </div>
          </div>
        ) : (
          <div className="px-2 pt-1" aria-label="Team document list">
            {query && (
              <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                Title contains “{query}”
                <Button variant="ghost" size="sm" onClick={() => setQuery("")}>
                  Clear
                </Button>
              </div>
            )}
            <div className="flex h-8 items-center gap-3 pr-2 pl-9 text-xs text-muted-foreground">
              <button
                aria-label="Order by name"
                className="flex min-w-0 flex-1 items-center gap-1 text-left hover:text-foreground"
                onClick={() => orderBy("name")}
              >
                Name
                {sort === "name" && (
                  <HomeIcon
                    icon={ArrowDown01Icon}
                    className={`size-3 ${ascending ? "" : "rotate-180"}`}
                  />
                )}
              </button>
              {showDate && (
                <>
                  <button
                    onClick={() => orderBy("created")}
                    className="hidden w-28 shrink-0 text-left hover:text-foreground md:block"
                  >
                    Created
                  </button>
                  <button
                    onClick={() => orderBy("updated")}
                    className="hidden w-28 shrink-0 text-left hover:text-foreground md:block"
                  >
                    Last edited
                  </button>
                </>
              )}
              {showOwner && (
                <button
                  onClick={() => orderBy("owner")}
                  className="hidden w-36 shrink-0 text-left hover:text-foreground lg:block"
                >
                  Owner
                </button>
              )}
              <span className="w-7 shrink-0" />
            </div>
            <div className="flex h-9 items-center gap-2 rounded-lg bg-muted/55 px-2 text-[13px]">
              <button
                aria-label={
                  collapsed
                    ? "Expand Team documents"
                    : "Collapse Team documents"
                }
                aria-expanded={!collapsed}
                onClick={() => setCollapsed(!collapsed)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <HomeIcon
                  icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
                  className="size-3 text-muted-foreground"
                />
                <TeamSidebarIcon
                  icon={team.icon}
                  name={team.name}
                  className="size-3.5"
                />
                <h2 className="truncate font-medium">Team documents</h2>
                <span className="text-xs text-muted-foreground">
                  {visible.length}
                </span>
              </button>
              <HomeIconButton
                label="Create document in Team documents"
                icon={Add01Icon}
                disabled={Boolean(store.error)}
                onClick={create}
              />
            </div>
            {!collapsed &&
              visible.map((resource) => (
                <div
                  key={resource.id}
                  className="group flex h-12 items-center gap-3 rounded-lg pr-2 pl-9 text-[13px] hover:bg-muted/35"
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => openDocument(resource.id)}
                  >
                    <TeamSidebarIcon
                      icon={resource.icon ?? defaultDocumentIcon}
                      name={resource.title}
                      className="size-4 text-muted-foreground"
                    />
                    <span className="truncate">{resource.title}</span>
                  </button>
                  {showDate && (
                    <>
                      <time
                        className="hidden w-28 shrink-0 text-xs text-muted-foreground md:block"
                        dateTime={resource.createdAt}
                        title={
                          resource.createdAt
                            ? new Date(resource.createdAt).toLocaleString()
                            : undefined
                        }
                      >
                        {resource.createdAt
                          ? documentTime(resource.createdAt)
                          : "—"}
                      </time>
                      <time
                        className="hidden w-28 shrink-0 text-xs text-muted-foreground md:block"
                        dateTime={resource.updatedAt}
                        title={new Date(resource.updatedAt).toLocaleString()}
                      >
                        {documentTime(resource.updatedAt)}
                      </time>
                    </>
                  )}
                  {showOwner && (
                    <span className="hidden w-36 shrink-0 items-center gap-2 lg:flex">
                      {resource.owner ? (
                        <>
                          <Avatar className="size-5">
                            <AvatarImage
                              src={resource.owner.image ?? undefined}
                              alt=""
                            />
                            <AvatarFallback className="text-[9px]">
                              {resource.owner.name
                                .split(/\s+/)
                                .map((part) => part[0])
                                .slice(0, 2)
                                .join("")}
                            </AvatarFallback>
                          </Avatar>
                          <span className="truncate">
                            {resource.owner.name}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <HomeIconButton
                          label={`Actions for ${resource.title}`}
                          icon={MoreHorizontalIcon}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                        />
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => openDocument(resource.id)}
                      >
                        Open document
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => remove(resource.id)}
                      >
                        Delete document
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            {visible.length === 0 && (
              <p
                role="status"
                className="py-16 text-center text-sm text-muted-foreground"
              >
                No matching documents
              </p>
            )}
          </div>
        )}
      </div>
    </TeamHomeLayout>
  )
}
