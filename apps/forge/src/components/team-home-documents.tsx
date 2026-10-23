import * as React from "react"
import {
  Add01Icon,
  File01Icon,
  FilterHorizontalIcon,
  MoreHorizontalIcon,
  Settings03Icon,
} from "@hugeicons/core-free-icons"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamResource } from "@/lib/team-home-state"
import { OptionSelect } from "@/components/ui/option-select"
import { useTeamHome } from "@/lib/team-home-state"
import {
  HomeIcon,
  HomeIconButton,
  ResourceEditor,
  TeamHomeLayout,
  homePill,
  homeSave,
  newResource,
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

;

("use client")

export function TeamDocuments({ team }: { team: TeamSummary }) {
  const store = useTeamHome(team.id)
  const [editor, setEditor] = React.useState<TeamResource | null>(null)
  const [query, setQuery] = React.useState("")
  const [sort, setSort] = React.useState("updated")
  const [showDate, setShowDate] = React.useState(true)
  const documents = store.state.resources.filter((r) => r.kind === "document")
  const visible = documents
    .filter((r) => r.title.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) =>
      sort === "name"
        ? a.title.localeCompare(b.title)
        : b.updatedAt.localeCompare(a.updatedAt)
    )
  const create = () => setEditor(newResource("document"))
  return (
    <TeamHomeLayout
      team={team}
      tab="documents"
      store={store}
      actions={
        <>
          <Button
            variant="secondary"
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
                  onValueChange={(nextValue) => setSort(nextValue)}
                  className="rounded-md bg-muted p-1"
                >
                  <option value="updated">Updated</option>
                  <option value="name">Name</option>
                </OptionSelect>
              </label>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showDate}
                  onChange={(e) => setShowDate(e.target.checked)}
                />
                Updated date
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
          <div className="px-4 pt-3">
            {query && (
              <div className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                Title contains “{query}”
                <Button variant="ghost" size="sm" onClick={() => setQuery("")}>
                  Clear
                </Button>
              </div>
            )}
            <div className="flex border-b border-border/40 py-2 text-xs text-muted-foreground">
              <span className="flex-1">Name</span>
              {showDate && <span className="w-32">Updated</span>}
              <span className="w-8" />
            </div>
            {visible.map((resource) => (
              <div
                key={resource.id}
                className="group flex items-center gap-3 rounded-lg py-3 hover:bg-muted/35"
              >
                <HomeIcon
                  icon={File01Icon}
                  className="ml-1 text-muted-foreground"
                />
                <button
                  className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
                  onClick={() => setEditor(resource)}
                >
                  {resource.title}
                </button>
                {showDate && (
                  <span className="w-32 text-xs text-muted-foreground">
                    {new Date(resource.updatedAt).toLocaleDateString()}
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
                    <DropdownMenuItem onClick={() => setEditor(resource)}>
                      Edit document
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() =>
                        homeSave(
                          store,
                          (s) => ({
                            ...s,
                            resources: s.resources.filter(
                              (r) => r.id !== resource.id
                            ),
                          }),
                          "Document deleted"
                        )
                      }
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
      {editor && (
        <ResourceEditor
          key={editor.id}
          resource={editor}
          store={store}
          onClose={() => setEditor(null)}
        />
      )}
    </TeamHomeLayout>
  )
}
