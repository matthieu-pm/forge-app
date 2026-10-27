import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import { CommandIcon, Cursor02Icon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { InitiativeComposer } from "./initiative-composer"
import {
  InitiativeDisplayMenu,
  InitiativeFiltersMenu,
  filterValueLabel,
} from "./initiative-view-controls"
import { InitiativeSummary } from "./initiative-summary"
import { InitiativeTable } from "./initiative-table"
import {
  InitiativePropertyPicker,
  initiativePrimary,
} from "./initiative-properties"
import type {
  Initiative,
  InitiativeFilters,
  InitiativePerson,
  InitiativePreferences,
  InitiativeView,
} from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import { IllustratedEmptyState } from "@/components/illustrations/illustrated-empty-state"
import { PageTabs, pageTabClass } from "@/components/ui/page-tabs"
import { ContentHeader } from "@/components/ui/content-header"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { IssueIcon } from "@/components/issues/issue-controls"
import { useInitiatives } from "@/lib/initiatives-state"
import {
  addInitiative,
  blankInitiative,
  emptyInitiativeFilters,
  patchInitiative,
  visibleInitiatives,
} from "@/lib/initiatives"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useAgent } from "@/components/agent/agent-provider"
import { directorySelectionToolbarClassName } from "@/components/ui/directory-table"

export function InitiativesPage({
  workspaceId,
  user,
  people: directoryPeople,
  teams,
  directoryError = "",
  view,
  onView,
  onOpen,
}: {
  workspaceId: string
  user: InitiativePerson
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  directoryError?: string
  view: InitiativeView
  onView: (view: InitiativeView) => void
  onOpen: (item: Initiative, tab: "overview" | "projects" | "updates") => void
}) {
  const store = useInitiatives(workspaceId, user.id)
  const agent = useAgent()
  const [creating, setCreating] = useState(false)
  const [filters, setFilters] = useState<InitiativeFilters>(
    emptyInitiativeFilters
  )
  const [filterOpen, setFilterOpen] = useState(false)
  const [selected, setSelected] = useState<Array<string>>([])
  const [actionError, setActionError] = useState("")
  const [, tick] = useState(0)
  const root = useRef<HTMLElement>(null)
  const sequence = useRef(0)
  const people = [
    ...directoryPeople.filter((person) => person.id !== user.id),
    user,
  ]
  const visible = visibleInitiatives(
    store.state.initiatives,
    view,
    filters,
    store.preferences,
    people,
    store.settings.schedule
  )
  const chosen = selected.filter((id) => visible.some((item) => item.id === id))
  useEffect(() => {
    root.current?.focus({ preventScroll: true })
    setSelected([])
    setCreating(false)
  }, [view])
  useEffect(() => {
    const timer = window.setInterval(() => tick((value) => value + 1), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  function fail() {
    setActionError(
      "The change could not be saved. Your existing initiatives have been preserved."
    )
  }
  function preferences(next: InitiativePreferences) {
    if (!store.savePreferences(next))
      toast.error("Display options could not be saved")
    else setActionError("")
  }
  function patch(item: Initiative, changes: Partial<Initiative>) {
    if (
      !store.update((current) => ({
        ...current,
        initiatives: current.initiatives.map((value) =>
          value.id === item.id ? patchInitiative(value, changes) : value
        ),
      }))
    )
      fail()
    else setActionError("")
  }
  function bulk(changes?: Partial<Initiative>) {
    if (
      store.update((current) => ({
        ...current,
        initiatives: changes
          ? current.initiatives.map((item) =>
              chosen.includes(item.id) ? patchInitiative(item, changes) : item
            )
          : current.initiatives.filter((item) => !chosen.includes(item.id)),
      }))
    ) {
      setSelected([])
      setActionError("")
    } else fail()
  }
  function create(draft: Omit<Initiative, "number">) {
    const saved = store.update((current) => addInitiative(current, draft))
    if (saved) {
      setFilters(emptyInitiativeFilters())
      setActionError("")
      const next =
        draft.status === "Active"
          ? "active"
          : draft.status === "Planned" || draft.status === "Proposed"
            ? "planned"
            : "all"
      if (view !== next) onView(next)
    }
    return saved
  }
  const errors = [
    store.error,
    store.preferencesError,
    store.settingsError,
    store.labelsError,
    directoryError,
    actionError,
  ].filter(Boolean)
  return (
    <main
      ref={root}
      tabIndex={-1}
      aria-label="Initiatives"
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background outline-none"
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          (event.target instanceof Element &&
            event.target.closest(
              'input,textarea,[contenteditable="true"],[role="dialog"],[role="menu"],[role="listbox"],[role="combobox"],[data-slot="popover-content"]'
            ))
        )
          return
        const key = event.key.toLowerCase()
        if (key === "n") sequence.current = Date.now()
        if (
          key === "i" &&
          Date.now() - sequence.current < 1500 &&
          store.writable
        ) {
          event.preventDefault()
          setCreating(true)
          sequence.current = 0
        }
        if (key === "f") {
          event.preventDefault()
          setFilterOpen(true)
        }
        if (key === "escape") {
          setCreating(false)
          setSelected([])
        }
      }}
    >
      <ContentHeader className="justify-between">
        <h1 className="text-[13px] font-medium">Initiatives</h1>
        <Button
          variant="outline"
          size="sm"
          disabled={!store.writable}
          onClick={() => setCreating(true)}
          className="gap-1.5 px-2 text-xs text-muted-foreground"
        >
          <IssueIcon name="add" />
          New initiative
        </Button>
      </ContentHeader>
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 px-2 py-2">
        <PageTabs aria-label="Initiative views">
          {(["active", "planned", "all"] as const).map((tab) => (
            <Link
              key={tab}
              to="/workspace/initiatives"
              search={{ view: tab }}
              aria-current={tab === view ? "page" : undefined}
              className={pageTabClass}
              onClick={() => {
                setSelected([])
                setCreating(false)
              }}
            >
              {tab === "all"
                ? "All initiatives"
                : tab === "active"
                  ? "Active"
                  : "Planned"}
            </Link>
          ))}
        </PageTabs>
        <div className="flex shrink-0 items-center gap-1.5">
          <InitiativeFiltersMenu
            open={filterOpen}
            onOpenChange={setFilterOpen}
            value={filters}
            onChange={(next) => {
              setFilters(next)
              setSelected([])
            }}
            people={people}
            teams={teams}
            labels={store.labels}
          />
          <InitiativeDisplayMenu
            value={store.preferences}
            onChange={preferences}
            disabled={Boolean(store.preferencesError)}
          />
          {store.state.initiatives.length > 0 && (
            <ActionIconButton
              label={
                store.preferences.sidebar ? "Close sidebar" : "Open sidebar"
              }
              aria-pressed={store.preferences.sidebar}
              className="aria-pressed:bg-secondary aria-pressed:text-foreground"
              onClick={() =>
                preferences({
                  ...store.preferences,
                  sidebar: !store.preferences.sidebar,
                })
              }
            >
              <IssueIcon name="details" />
            </ActionIconButton>
          )}
        </div>
      </div>
      {errors.length > 0 && (
        <div
          role="alert"
          className="shrink-0 px-4 py-2 text-xs text-destructive"
        >
          {[...new Set(errors)].join(" ")}
        </div>
      )}
      {!store.settings.enabled && (
        <p role="status" className="px-4 py-3 text-xs text-muted-foreground">
          Initiatives are disabled for this workspace.{" "}
          <Link
            to="/settings/initiatives"
            className="text-foreground underline"
          >
            Open initiative settings
          </Link>
        </p>
      )}
      {filters.rules.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-1 px-3 pb-2">
          {filters.rules.map((rule) => (
            <Button
              key={rule.id}
              variant="secondary"
              size="xs"
              aria-label={`Remove ${rule.field} filter`}
              className="max-w-full rounded-md text-[11px]"
              onClick={() =>
                setFilters({
                  ...filters,
                  rules: filters.rules.filter(
                    (current) => current.id !== rule.id
                  ),
                })
              }
            >
              <span className="truncate">
                {rule.field} {rule.operator}{" "}
                {filterValueLabel(rule, {
                  people,
                  teams,
                  labels: store.labels,
                })}
              </span>
              <IssueIcon name="close" className="size-3" />
            </Button>
          ))}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setFilters(emptyInitiativeFilters())}
          >
            Clear filters
          </Button>
        </div>
      )}
      {creating && (
        <InitiativeComposer
          creatorId={user.id}
          view={view}
          people={people}
          teams={teams}
          labels={store.labels}
          onCreate={create}
          onCancel={() => setCreating(false)}
        />
      )}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {!store.ready ? (
          <p role="status" className="p-8 text-sm text-muted-foreground">
            Loading initiatives...
          </p>
        ) : visible.length ? (
          <InitiativeTable
            items={visible}
            preferences={store.preferences}
            people={people}
            teams={teams}
            labels={store.labels}
            schedule={store.settings.schedule}
            selected={chosen}
            disabled={!store.writable}
            onSelect={(id) =>
              setSelected((current) =>
                current.includes(id)
                  ? current.filter((value) => value !== id)
                  : [...current, id]
              )
            }
            onPatch={patch}
            onOpen={onOpen}
            onOrder={(ordering) =>
              preferences({
                ...store.preferences,
                ordering,
                descending:
                  store.preferences.ordering === ordering
                    ? !store.preferences.descending
                    : ordering === "Created" || ordering === "Updated",
              })
            }
            onReorder={(from, to) => {
              if (
                !store.update((current) => {
                  const moving = current.initiatives.find(
                    (item) => item.id === from
                  )
                  if (!moving) return current
                  const items = current.initiatives.filter(
                    (item) => item.id !== from
                  )
                  const position = items.findIndex((item) => item.id === to)
                  if (position < 0) return current
                  items.splice(position, 0, moving)
                  return { ...current, initiatives: items }
                })
              )
                fail()
            }}
          />
        ) : (
          !creating && (
            <IllustratedEmptyState
              kind="initiatives"
              title={
                filters.rules.length
                  ? "No matching initiatives"
                  : store.state.initiatives.length
                    ? view === "planned"
                      ? "No planned initiatives"
                      : view === "active"
                        ? "No active initiatives"
                        : "Initiatives"
                    : "Initiatives"
              }
              actions={
                <>
                  {filters.rules.length ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setFilters(emptyInitiativeFilters())}
                    >
                      Clear filters
                    </Button>
                  ) : (
                    <Button
                      disabled={!store.writable}
                      onClick={() => setCreating(true)}
                      className={initiativePrimary}
                    >
                      Create new initiative
                      <span className="ml-1 hidden items-center gap-1 text-[10px] text-white/70 sm:inline-flex">
                        <kbd className="rounded border border-white/25 px-1">
                          N
                        </kbd>
                        then
                        <kbd className="rounded border border-white/25 px-1">
                          I
                        </kbd>
                      </span>
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    size="sm"
                    nativeButton={false}
                    className="text-xs"
                    render={
                      <a
                        href="https://linear.app/docs/initiatives"
                        target="_blank"
                        rel="noreferrer"
                      />
                    }
                  >
                    Documentation
                  </Button>
                </>
              }
            >
              <p>
                {filters.rules.length
                  ? "Adjust your filters to see more initiatives."
                  : "Initiatives are larger, strategic product efforts that set the direction of your company. They are comprised of all projects that align with the goals of the initiative and allow you to monitor their progress at scale."}
              </p>
            </IllustratedEmptyState>
          )
        )}
        {store.preferences.sidebar && store.state.initiatives.length > 0 && (
          <InitiativeSummary
            items={store.state.initiatives}
            view={view}
            filters={filters}
            preferences={store.preferences}
            people={people}
            teams={teams}
            schedule={store.settings.schedule}
            onPreferences={preferences}
            onFilters={setFilters}
            onClose={() =>
              preferences({ ...store.preferences, sidebar: false })
            }
          />
        )}
      </div>
      {chosen.length > 0 && (
        <div
          role="toolbar"
          aria-label="Selected initiatives"
          className={directorySelectionToolbarClassName}
        >
          <span role="status" className="mr-1 whitespace-nowrap">
            {chosen.length} selected
          </span>
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label="Open initiative command menu"
                  className="h-7 gap-1.5 rounded-full border border-border/40 px-2.5 text-xs font-normal"
                />
              }
            >
              <HugeiconsIcon
                icon={CommandIcon}
                strokeWidth={1.5}
                className="size-3.5"
              />
              Actions
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="center"
              className="w-64 gap-2 rounded-xl p-3"
            >
              <p className="pb-1 text-xs text-muted-foreground">
                Update {chosen.length} selected initiatives
              </p>
              {(["status", "priority", "owner"] as const).map((property) => (
                <InitiativePropertyPicker
                  key={property}
                  property={property}
                  item={{
                    ...blankInitiative(user.id),
                    name: "selected initiatives",
                  }}
                  people={people}
                  teams={teams}
                  labels={store.labels}
                  onChange={bulk}
                  disabled={!store.writable}
                />
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="justify-start text-xs text-destructive"
                aria-label="Delete selected initiatives"
                disabled={!store.writable}
                onClick={() => bulk()}
              >
                <IssueIcon name="delete" /> Delete initiatives
              </Button>
            </PopoverContent>
          </Popover>
          <Button
            variant="secondary"
            size="icon-sm"
            className="size-7 rounded-full border border-border/40 text-muted-foreground"
            aria-label="Ask Forge about selected initiatives"
            onClick={() => {
              const items = visible.filter((item) => chosen.includes(item.id))
              agent.openComposer("floating")
              agent.setDraft(
                `Help me with these initiatives:\n${items.map((item) => `I-${item.number}: ${item.name}\n${item.summary}\nStatus: ${item.status}\nPriority: ${item.priority}`).join("\n\n")}`
              )
            }}
          >
            <HugeiconsIcon
              icon={Cursor02Icon}
              strokeWidth={1.5}
              className="size-3.5"
            />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear initiative selection"
            className="size-7 rounded-full text-muted-foreground"
            onClick={() => setSelected([])}
          >
            <IssueIcon name="close" />
          </Button>
        </div>
      )}
    </main>
  )
}
