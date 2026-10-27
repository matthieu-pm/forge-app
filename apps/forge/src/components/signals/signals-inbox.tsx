import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Archive02Icon,
  ArrowLeft01Icon,
  ArrowTurnBackwardIcon,
  Asteroid02Icon,
  FilterHorizontalIcon,
  Link01Icon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import { SignalsConnectionsDialog } from "./signals-connections"
import { SignalsInsightReport } from "./signals-insight-report"
import type { InboxScope } from "@/lib/inbox-state"
import type { SignalInsight, SignalInsightStatus } from "@/lib/signals-insights"
import type { TeamSummary } from "@/lib/team-contract"
import type { TemplateDirectory } from "@/lib/template-contract"
import type { IssueDraft } from "@/lib/team-issues"
import {
  filterSignalInsights,
  sampleSignalInsights,
} from "@/lib/signals-insights"
import {
  resolveSignalScope,
  sampleSignalAccounts,
} from "@/lib/signals-accounts"
import { blankIssueDraft } from "@/lib/team-issues"
import { useMyIssueData } from "@/lib/my-issues-state"
import { loadTemplates } from "@/lib/template-state"
import { InboxSidebar } from "@/components/inbox/inbox-sidebar"
import { ContentHeader } from "@/components/ui/content-header"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { Button } from "@/components/ui/button"
import { PageTabs, pageTabClass } from "@/components/ui/page-tabs"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { IssueComposer } from "@/components/issues/issue-composer"
import { cn } from "@/lib/utils"
import { newSignalDocument, useSignalDocuments } from "@/lib/signals-documents"

const views: Array<{ id: SignalInsightStatus; name: string }> = [
  { id: "inbox", name: "To review" },
  { id: "reviewed", name: "Reviewed" },
  { id: "dismissed", name: "Dismissed" },
]

export function SignalsInbox({
  scope,
  team,
}: {
  scope: InboxScope
  team?: TeamSummary
}) {
  const [view, setView] = useState<SignalInsightStatus>("inbox")
  const [statuses, setStatuses] = useState<Record<string, SignalInsightStatus>>(
    {}
  )
  const [selectedId, setSelectedId] = useState(sampleSignalInsights[0].id)
  const [read, setRead] = useState(() => new Set([sampleSignalInsights[0].id]))
  const [query, setQuery] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const [projectId, setProjectId] = useState("")
  const [highConfidence, setHighConfidence] = useState(false)
  const [mobileDetail, setMobileDetail] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [drafts, setDrafts] = useState<
    Partial<Record<string, { draft: IssueDraft; team: TeamSummary }>>
  >({})
  const [draftIds] = useState(() =>
    Object.fromEntries(
      sampleSignalInsights.map((insight) => [insight.id, crypto.randomUUID()])
    )
  )
  const [directory, setDirectory] = useState<TemplateDirectory | null>(null)
  const [directoryError, setDirectoryError] = useState("")
  const [directoryAttempt, setDirectoryAttempt] = useState(0)
  const [created, setCreated] = useState<
    Partial<Record<string, { id: string; identifier: string; slug: string }>>
  >({})
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const documentStore = useSignalDocuments(scope)
  const [initialDocuments] = useState(() =>
    Object.fromEntries(
      sampleSignalInsights.map((insight) => [
        insight.id,
        newSignalDocument(insight),
      ])
    )
  )
  useEffect(() => {
    let active = true
    setDirectoryError("")
    void loadTemplates({ data: team ? { slug: team.slug } : {} })
      .then((result) => {
        if (active) setDirectory(result)
      })
      .catch(() => {
        if (active)
          setDirectoryError(
            "Teams could not be loaded. You can still read and edit the draft."
          )
      })
    return () => {
      active = false
    }
  }, [team?.slug, directoryAttempt])
  const options = { statuses, projectId, query, highConfidence }
  const visible = filterSignalInsights(sampleSignalInsights, {
    ...options,
    status: view,
  })
  const selected =
    visible.find((insight) => insight.id === selectedId) ?? visible.at(0)
  const savedDraft = selected ? drafts[selected.id] : undefined
  const currentDraft = selected
    ? (savedDraft?.draft ?? {
        ...blankIssueDraft(),
        title: selected.draft.title,
        description: selected.draft.description,
        priority: selected.draft.priority,
      })
    : null
  const createdIssue = selected ? created[selected.id] : undefined
  const targetTeam = savedDraft?.team ?? team ?? directory?.teams.at(0)
  const availableTeams = useMemo(
    () => directory?.teams ?? (team ? [team] : []),
    [directory, team]
  )
  const issueData = useMyIssueData(availableTeams)
  const selectedProject = sampleSignalAccounts
    .flatMap((account) => account.projects)
    .find((project) => project.id === projectId)
  const activeAccount = selected?.accountId ?? sampleSignalAccounts[0].id

  function select(insight: SignalInsight) {
    setSelectedId(insight.id)
    setRead((current) => new Set([...current, insight.id]))
    setMobileDetail(true)
  }
  function move(status: SignalInsightStatus) {
    if (!selected) return
    setStatuses((current) => ({ ...current, [selected.id]: status }))
    toast.success(
      status === "reviewed"
        ? "Insight marked as reviewed"
        : status === "dismissed"
          ? "Insight dismissed"
          : "Insight returned to review"
    )
  }

  return (
    <main
      aria-label="Signals insight inbox"
      className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
    >
      <InboxSidebar
        scope={scope}
        selected={mobileDetail}
        label="Insights"
        storageNamespace="signals"
      >
        <ContentHeader>
          <h2 className="text-[13px] font-medium">Insights</h2>
          <span className="text-xs text-muted-foreground">
            {visible.length}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <ActionIconButton
              label="Manage analytics connections"
              icon={Link01Icon}
              onClick={() => setConnectionsOpen(true)}
            />
            <ActionIconButton
              label="Search insights"
              icon={Search01Icon}
              aria-pressed={searchOpen}
              onClick={() => {
                setSearchOpen(!searchOpen)
                if (searchOpen) setQuery("")
              }}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <ActionIconButton
                    label="Filter insights"
                    icon={FilterHorizontalIcon}
                  />
                }
              />
              <DropdownMenuContent className="w-64 rounded-xl" align="end">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Product</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={projectId}
                    onValueChange={(value) => {
                      setProjectId(value)
                      setMobileDetail(false)
                    }}
                  >
                    <DropdownMenuRadioItem value="" className="text-xs">
                      All products
                    </DropdownMenuRadioItem>
                    {sampleSignalAccounts.flatMap((account) =>
                      account.projects.map((project) => (
                        <DropdownMenuRadioItem
                          key={project.id}
                          value={project.id}
                          className="text-xs"
                        >
                          {account.name} / {project.name}
                        </DropdownMenuRadioItem>
                      ))
                    )}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem
                  checked={highConfidence}
                  onCheckedChange={setHighConfidence}
                  className="text-xs"
                >
                  High confidence only (85%+)
                </DropdownMenuCheckboxItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContentHeader>
        <div className="border-b border-border/40 px-3 py-2">
          <PageTabs aria-label="Insight queues" className="gap-1">
            {views.map((item) => (
              <Button
                key={item.id}
                size="xs"
                variant="outline"
                className={cn(pageTabClass, "gap-1.5 px-2 text-[11px]")}
                aria-pressed={view === item.id}
                onClick={() => {
                  setView(item.id)
                  setMobileDetail(false)
                }}
              >
                {item.name}
                <span className="text-[10px] text-muted-foreground">
                  {
                    filterSignalInsights(sampleSignalInsights, {
                      ...options,
                      status: item.id,
                    }).length
                  }
                </span>
              </Button>
            ))}
          </PageTabs>
          {(projectId || highConfidence) && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span>
                {selectedProject?.name ?? "All products"}
                {highConfidence ? " · High confidence" : ""}
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto text-[11px]"
                onClick={() => {
                  setProjectId("")
                  setHighConfidence(false)
                }}
              >
                Clear filters
              </Button>
            </div>
          )}
          {searchOpen && (
            <Input
              autoFocus
              type="search"
              aria-label="Search insights"
              placeholder="Search insights…"
              className="mt-2 h-8 text-xs"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          )}
        </div>
        <div
          aria-label="Insight list"
          className="min-h-0 flex-1 overflow-y-auto p-2"
        >
          {visible.map((insight, index) => {
            const product = resolveSignalScope(
              insight.accountId,
              insight.projectId
            )
            return (
              <button
                key={insight.id}
                ref={(node) => {
                  if (node) rowRefs.current.set(insight.id, node)
                  else rowRefs.current.delete(insight.id)
                }}
                type="button"
                aria-pressed={selected?.id === insight.id}
                aria-label={`Open insight: ${insight.title}`}
                onClick={() => select(insight)}
                onKeyDown={(event) => {
                  const nextIndex =
                    event.key === "ArrowDown"
                      ? Math.min(index + 1, visible.length - 1)
                      : event.key === "ArrowUp"
                        ? Math.max(index - 1, 0)
                        : undefined
                  if (nextIndex === undefined) return
                  event.preventDefault()
                  select(visible[nextIndex])
                  rowRefs.current.get(visible[nextIndex].id)?.focus()
                }}
                className={cn(
                  "group mb-0.5 flex w-full items-start gap-3 rounded-lg px-2.5 py-3 text-left outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  selected?.id === insight.id && "bg-muted/70"
                )}
              >
                <span className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <HugeiconsIcon
                    icon={Asteroid02Icon}
                    strokeWidth={1.5}
                    className="size-4"
                  />
                  {!read.has(insight.id) && (
                    <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-primary ring-2 ring-background" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={cn(
                      "block truncate text-[13px] leading-5",
                      !read.has(insight.id) && "font-medium"
                    )}
                  >
                    {insight.title}
                  </span>
                  <InsightDescription>{insight.description}</InsightDescription>
                  <span className="mt-2 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">
                      {product.account.name} / {product.project.name}
                    </span>
                    <span
                      title={insight.confidenceReason}
                      className="shrink-0 tabular-nums"
                    >
                      {insight.confidence}% confidence
                    </span>
                  </span>
                </span>
              </button>
            )
          })}
          {!visible.length && (
            <div className="flex min-h-48 flex-col items-center justify-center gap-2 px-6 text-center">
              <HugeiconsIcon
                icon={Asteroid02Icon}
                strokeWidth={1.2}
                className="size-8 text-muted-foreground/70"
              />
              <p className="text-[13px]">
                {query || projectId || highConfidence
                  ? "No matching insights"
                  : view === "inbox"
                    ? "You're all caught up"
                    : view === "reviewed"
                      ? "No reviewed insights"
                      : "No dismissed insights"}
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                {query || projectId || highConfidence
                  ? "Try a different search or filter."
                  : "Insights will appear here as you review them."}
              </p>
            </div>
          )}
        </div>
        <footer className="flex h-9 shrink-0 items-center justify-between border-t border-border/40 px-4 text-[10px] text-muted-foreground">
          <span>Sample insights</span>
          <span>Updated Oct 26</span>
        </footer>
      </InboxSidebar>

      <section
        aria-label="Insight details"
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col",
          mobileDetail ? "flex" : "hidden md:flex"
        )}
      >
        <ContentHeader>
          <ActionIconButton
            label="Back to insights"
            icon={ArrowLeft01Icon}
            className="md:hidden"
            onClick={() => setMobileDetail(false)}
          />
          <span className="text-xs text-muted-foreground">
            {selected?.id ?? "Insights"}
          </span>
          {selected && (
            <div className="ml-auto flex items-center gap-1">
              {view !== "inbox" && (
                <ActionIconButton
                  label="Return to review"
                  icon={ArrowTurnBackwardIcon}
                  onClick={() => move("inbox")}
                />
              )}
              {view !== "reviewed" && (
                <ActionIconButton
                  label="Mark insight reviewed"
                  icon={Tick02Icon}
                  onClick={() => move("reviewed")}
                />
              )}
              {view !== "dismissed" && (
                <ActionIconButton
                  label="Dismiss insight"
                  icon={Archive02Icon}
                  onClick={() => move("dismissed")}
                />
              )}
            </div>
          )}
        </ContentHeader>
        {documentStore.error && (
          <div
            role="alert"
            className="flex items-center gap-3 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive"
          >
            <span className="flex-1">{documentStore.error}</span>
            {!documentStore.readError && (
              <Button size="sm" variant="ghost" onClick={documentStore.retry}>
                Try again
              </Button>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto" key={selected?.id}>
          {selected && currentDraft && documentStore.ready ? (
            <>
              <SignalsInsightReport
                key={selected.id}
                insight={selected}
                document={
                  documentStore.documents[initialDocuments[selected.id].id] ??
                  initialDocuments[selected.id]
                }
                onDocumentChange={documentStore.save}
                issueComposer={
                  createdIssue ? (
                    <Button
                      render={
                        <Link
                          to="/teams/$teamSlug/issues"
                          params={{ teamSlug: createdIssue.slug }}
                          search={{ view: "all", issue: createdIssue.id }}
                        />
                      }
                      variant="outline"
                      size="sm"
                    >
                      {createdIssue.identifier} · Open issue
                    </Button>
                  ) : targetTeam ? (
                    <IssueComposer
                      presentation="inline"
                      team={targetTeam}
                      directory={directory ?? undefined}
                      initial={currentDraft}
                      draftId={draftIds[selected.id]}
                      labels={
                        issueData.contexts.find(
                          (context) => context.team.id === targetTeam.id
                        )?.labels ?? []
                      }
                      projects={[
                        ...new Set(
                          issueData.contexts.flatMap((context) =>
                            context.issues
                              .map((issue) => issue.project ?? "")
                              .filter(Boolean)
                          )
                        ),
                      ]}
                      onDraftChange={(draft, draftTeam) =>
                        setDrafts((current) => {
                          const previous = current[selected.id]
                          return previous?.draft === draft &&
                            previous.team.id === draftTeam.id
                            ? current
                            : {
                                ...current,
                                [selected.id]: { draft, team: draftTeam },
                              }
                        })
                      }
                      onClose={() => {}}
                      onDraftSaved={() =>
                        toast.success("Draft saved in the team's Issues page")
                      }
                      onSaved={(issue, issueTeam) => {
                        setCreated((current) => ({
                          ...current,
                          [selected.id]: {
                            id: issue.id,
                            identifier: `${issueTeam.identifier}-${issue.number}`,
                            slug: issueTeam.slug,
                          },
                        }))
                        toast.success("Issue created")
                      }}
                    />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {directory
                        ? "Join a team to create this issue."
                        : "Loading issue composer…"}
                    </p>
                  )
                }
              />
              {!targetTeam && (
                <div className="mx-auto mb-8 max-w-[780px] px-6 text-xs text-muted-foreground sm:px-10">
                  {directoryError ? (
                    <>
                      <p role="alert">{directoryError}</p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-2"
                        onClick={() =>
                          setDirectoryAttempt((attempt) => attempt + 1)
                        }
                      >
                        Retry loading teams
                      </Button>
                    </>
                  ) : directory ? (
                    <p>Join a team to turn this draft into an issue.</p>
                  ) : (
                    <p role="status">Loading teams for issue creation…</p>
                  )}
                </div>
              )}
            </>
          ) : (
            <div className="flex min-h-72 items-center justify-center p-8 text-sm text-muted-foreground">
              Select an insight to review
            </div>
          )}
        </div>
      </section>
      <SignalsConnectionsDialog
        open={connectionsOpen}
        onOpenChange={setConnectionsOpen}
        accountId={activeAccount}
        onSelect={(accountId) => {
          setProjectId(resolveSignalScope(accountId).project.id)
          setMobileDetail(false)
        }}
      />
    </main>
  )
}

function InsightDescription({ children }: { children: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [overflowing, setOverflowing] = useState(false)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    let disposed = false
    const measure = () => {
      if (!disposed) setOverflowing(element.scrollWidth > element.clientWidth)
    }
    measure()
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure)
    observer?.observe(element)
    // FontFaceSet is absent in non-browser renderers such as JSDOM.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    void document.fonts?.ready.then(measure)
    return () => {
      disposed = true
      observer?.disconnect()
    }
  }, [children])

  const mask = overflowing
    ? "linear-gradient(to right, #000 calc(100% - 24px), transparent)"
    : undefined

  return (
    <span
      ref={ref}
      data-overflow={overflowing || undefined}
      className="mt-0.5 block overflow-hidden text-xs leading-5 whitespace-nowrap text-muted-foreground"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
    >
      {children}
    </span>
  )
}
