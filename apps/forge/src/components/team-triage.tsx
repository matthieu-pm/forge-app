import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Add01Icon,
  ArrowUpDownIcon,
  Settings02Icon,
  StarIcon,
  UserGroup03Icon,
} from "@hugeicons/core-free-icons"
import type { TeamSummary } from "@/lib/team-contract"
import type { TriageDraft, TriageIssue } from "@/lib/triage-issues"
import { ContentHeader } from "@/components/ui/content-header"
import { OptionSelect } from "@/components/ui/option-select"
import {
  triageDraftKey,
  triageDraftSchema,
  useTriageIssues,
} from "@/lib/triage-issues"
import { useTeamTriage } from "@/lib/team-triage"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { TriageResponsibilityDialog } from "@/components/triage-responsibility-dialog"
import { Button } from "@/components/ui/button"
import { TriageFilterChips, TriageFilters } from "@/components/triage-filters"
import { emptyTriageFilters, matchesTriageFilters } from "@/lib/triage-filters"
import { TriageIssueComposer } from "@/components/triage-issue-composer"
import { Switch } from "@/components/ui/switch"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

const selectClass = "h-8 rounded-lg border border-border bg-muted px-2 text-xs"
const emptyDraft = (): TriageDraft => ({
  title: "",
  description: "",
  priority: "No priority",
  dueDate: "",
})
function TriageMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 120 88"
      className="mb-3 h-20 w-28 text-muted-foreground"
    >
      {[0, 1, 2].map((ring) => (
        <ellipse
          key={ring}
          cx="60"
          cy="44"
          rx={55 - ring * 5}
          ry={33 - ring * 4}
          fill="none"
          stroke="currentColor"
          strokeDasharray="3 3"
          opacity={0.3 + ring * 0.1}
          transform="rotate(-8 60 44)"
        />
      ))}
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        transform="rotate(-8 60 44)"
      >
        <path d="M34 37v15q0 3 3 3h29v-5H40V37zM86 47V32q0-3-3-3H54v5h26v13z" />
        <rect
          x="50"
          y="40"
          width="20"
          height="5"
          rx="2.5"
          transform="rotate(-20 60 43)"
        />
      </g>
    </svg>
  )
}

export function TeamTriage({ team }: { team: TeamSummary }) {
  const { settings, ready, error: settingsError } = useTeamTriage(team.id)
  const { issues, error, save } = useTriageIssues(team.id)
  const [responsibility, setResponsibility] = useState(false)
  const [favorite, setFavorite] = useState(false)
  const [filters, setFilters] = useState(emptyTriageFilters)
  const [ordering, setOrdering] = useState("added")
  const [descending, setDescending] = useState(true)
  const [showSnoozed, setShowSnoozed] = useState(false)
  const [properties, setProperties] = useState(["ID", "SLA", "Due date"])
  const [selectedId, setSelectedId] = useState<string>()
  const [editor, setEditor] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const [draft, setDraft] = useState<TriageDraft>(emptyDraft)
  const [saveError, setSaveError] = useState<string | null>(null)
  const failure = settingsError ?? error
  const visible = issues
    .filter(
      (issue) =>
        (showSnoozed || !issue.snoozed) && matchesTriageFilters(issue, filters)
    )
    .sort((a, b) => {
      const result =
        ordering === "priority"
          ? { "No priority": 0, Urgent: 4, High: 3, Medium: 2, Low: 1 }[
              a.priority
            ] -
            { "No priority": 0, Urgent: 4, High: 3, Medium: 2, Low: 1 }[
              b.priority
            ]
          : ordering === "due"
            ? (a.dueDate || "9999").localeCompare(b.dueDate || "9999")
            : a.createdAt.localeCompare(b.createdAt)
      return descending ? -result : result
    })
  const selected = visible.find((issue) => issue.id === selectedId)
  function openEditor(issue?: TriageIssue) {
    setSaveError(null)
    if (issue) setDraft(issue)
    else {
      try {
        const raw = localStorage.getItem(triageDraftKey(team.id))
        setDraft(
          raw
            ? triageDraftSchema.parse(JSON.parse(raw))
            : editingId
              ? emptyDraft()
              : draft
        )
      } catch {
        setSaveError(
          "Your saved draft could not be loaded. It has been preserved."
        )
      }
    }
    setEditingId(issue?.id)
    setEditor(true)
  }
  function toggleSnooze(issue: TriageIssue) {
    try {
      save(issue, issue.id, !issue.snoozed)
      setSelectedId(undefined)
      setSaveError(null)
    } catch {
      setSaveError("The issue could not be saved. Please try again.")
    }
  }
  if (!ready)
    return (
      <main className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading triage…
      </main>
    )
  if (failure)
    return (
      <main className="p-6">
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      </main>
    )
  if (!settings.enabled)
    return (
      <main className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
        <h1 className="text-base font-medium">Triage is disabled</h1>
        <Link
          to="/settings/teams/$teamSlug/triage"
          params={{ teamSlug: team.slug }}
          className="text-sm text-primary underline"
        >
          Enable triage in team settings
        </Link>
      </main>
    )
  return (
    <main
      aria-label={`${team.name} triage`}
      className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row"
    >
      <section
        aria-label="Triage queue"
        className="flex min-h-0 shrink-0 flex-col border-b border-border/50 md:w-[400px] md:max-w-[42%] md:border-r md:border-b-0"
      >
        <ContentHeader>
          <TeamSidebarIcon
            icon={team.icon}
            name={team.name}
            className="size-4"
          />
          <h1 className="text-[13px] font-medium">Triage</h1>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Add to favorites"
            aria-pressed={favorite}
            onClick={() => setFavorite(!favorite)}
          >
            <HugeiconsIcon
              icon={StarIcon}
              className={
                favorite
                  ? "fill-amber-400 text-amber-400"
                  : "text-muted-foreground"
              }
            />
          </Button>
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              variant="outline"
              size="icon-sm"
              aria-label="Configure triage responsibility"
              title="Configure triage responsibility"
              onClick={() => setResponsibility(true)}
            >
              <HugeiconsIcon icon={UserGroup03Icon} />
            </Button>
            <TriageFilters
              team={team}
              issues={issues}
              value={filters}
              onChange={setFilters}
            />
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label="Display options"
                    title="Display options"
                  />
                }
              >
                <HugeiconsIcon icon={Settings02Icon} />
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-[300px] gap-0 rounded-xl p-0"
              >
                <div className="flex items-center gap-2 border-b border-border/50 p-4">
                  <span className="mr-auto text-xs text-muted-foreground">
                    Ordering
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Direction"
                    aria-pressed={descending}
                    title={descending ? "Descending" : "Ascending"}
                    onClick={() => setDescending(!descending)}
                  >
                    <HugeiconsIcon icon={ArrowUpDownIcon} />
                  </Button>
                  <OptionSelect
                    aria-label="View ordering"
                    className={selectClass}
                    value={ordering}
                    onValueChange={(nextValue) => setOrdering(nextValue)}
                  >
                    <option value="added">Added to triage</option>
                    <option value="priority">Priority</option>
                    <option value="due">Due date</option>
                  </OptionSelect>
                </div>
                <div className="flex items-center justify-between border-b border-border/50 p-4 text-xs text-muted-foreground">
                  Show snoozed
                  <Switch
                    size="sm"
                    checked={showSnoozed}
                    onCheckedChange={setShowSnoozed}
                    aria-label="Show snoozed"
                  />
                </div>
                <div className="p-4">
                  <p className="mb-3 text-xs text-muted-foreground">
                    Display properties
                  </p>
                  <div className="flex gap-1">
                    {["ID", "SLA", "Due date"].map((property) => (
                      <Button
                        key={property}
                        variant={
                          properties.includes(property) ? "secondary" : "ghost"
                        }
                        size="sm"
                        className="rounded-full px-2 text-xs"
                        aria-pressed={properties.includes(property)}
                        onClick={() =>
                          setProperties(
                            properties.includes(property)
                              ? properties.filter((item) => item !== property)
                              : [...properties, property]
                          )
                        }
                      >
                        {property}
                      </Button>
                    ))}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </ContentHeader>
        <TriageFilterChips value={filters} onChange={setFilters} />
        <div className="max-h-56 overflow-y-auto md:max-h-none md:flex-1">
          {visible.map((issue) => (
            <button
              key={issue.id}
              aria-label={`Open ${team.identifier}-T${issue.number} ${issue.title}`}
              aria-pressed={selectedId === issue.id}
              onClick={() => setSelectedId(issue.id)}
              className={`flex w-full flex-col gap-1 border-b border-border/40 px-4 py-3 text-left text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${selectedId === issue.id ? "bg-muted/60" : ""}`}
            >
              <span className="truncate">{issue.title}</span>
              <span className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                {properties.includes("ID") && (
                  <span>
                    {team.identifier}-T{issue.number}
                  </span>
                )}
                {issue.priority !== "No priority" && (
                  <span>{issue.priority}</span>
                )}
                {properties.includes("Due date") && issue.dueDate && (
                  <span>Due {issue.dueDate}</span>
                )}
                {properties.includes("SLA") && <span>No SLA</span>}
                {issue.snoozed && <span>Snoozed</span>}
              </span>
            </button>
          ))}
        </div>
        {issues.length > 0 && (
          <Button
            variant="ghost"
            className="m-2 shrink-0"
            onClick={() => openEditor()}
          >
            <HugeiconsIcon icon={Add01Icon} />
            Create triage issue
          </Button>
        )}
      </section>
      <section
        aria-label="Triage issue details"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
      >
        {selected ? (
          <article className="mx-auto w-full max-w-3xl p-6 sm:p-10">
            <p className="mb-4 text-xs text-muted-foreground">
              {team.identifier}-T{selected.number} · Triage
            </p>
            <h2 className="text-xl font-medium">{selected.title}</h2>
            <p className="mt-5 text-sm whitespace-pre-wrap text-muted-foreground">
              {selected.description || "No description"}
            </p>
            {(selected.project || selected.labels || selected.dueDate) && (
              <dl className="mt-5 flex flex-wrap gap-5 text-xs text-muted-foreground">
                {selected.project && (
                  <div>
                    <dt>Project</dt>
                    <dd className="mt-1 text-foreground">{selected.project}</dd>
                  </div>
                )}
                {selected.labels && (
                  <div>
                    <dt>Labels</dt>
                    <dd className="mt-1 text-foreground">{selected.labels}</dd>
                  </div>
                )}
                {selected.dueDate && (
                  <div>
                    <dt>Due date</dt>
                    <dd className="mt-1 text-foreground">{selected.dueDate}</dd>
                  </div>
                )}
              </dl>
            )}
            {!!selected.attachments?.length && (
              <ul className="mt-5 space-y-2">
                {selected.attachments.map((file, index) => (
                  <li key={`${file.name}-${index}`}>
                    <a
                      className="text-xs underline underline-offset-4"
                      href={file.data}
                      download={file.name}
                    >
                      {file.name}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {selected.priority}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => openEditor(selected)}
              >
                Edit issue
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => toggleSnooze(selected)}
              >
                {selected.snoozed ? "Unsnooze" : "Snooze"}
              </Button>
            </div>
            {saveError && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {saveError}
              </p>
            )}
          </article>
        ) : (
          <div className="flex min-h-72 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <TriageMark />
            <p className="text-sm text-muted-foreground">
              {visible.length
                ? "Select an issue to triage"
                : issues.length
                  ? "No issues match this view"
                  : "Nothing to triage"}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-1 rounded-full px-3 text-xs font-normal"
              onClick={() => openEditor()}
            >
              <HugeiconsIcon icon={Add01Icon} className="size-3" />
              Create triage issue
            </Button>
          </div>
        )}
      </section>
      <TriageResponsibilityDialog
        teamId={team.id}
        open={responsibility}
        onOpenChange={setResponsibility}
      />
      <TriageIssueComposer
        team={team}
        open={editor}
        onOpenChange={setEditor}
        draft={draft}
        onDraftChange={setDraft}
        editing={!!editingId}
        error={saveError}
        onError={setSaveError}
        onSave={() => {
          try {
            const issue = save(draft, editingId)
            setSelectedId(issue.id)
            setSaveError(null)
            return true
          } catch {
            setSaveError(
              "The issue could not be saved. Your draft is still here. Please try again."
            )
            return false
          }
        }}
      />
    </main>
  )
}
