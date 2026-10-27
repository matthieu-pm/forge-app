import { useCallback, useEffect, useRef, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Call02Icon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import { CallDetail } from "./call-detail"
import {
  ConnectCallsDialog,
  ImportCallDialog,
  ProviderMark,
} from "./call-dialogs"
import type { CallRecord, CallsDirectory } from "@/lib/calls"
import type { InboxScope } from "@/lib/inbox-state"
import type { TeamSummary } from "@/lib/team-contract"
import { EmptyStateArt } from "@/components/illustrations/empty-state-art"
import { PageTabs, pageTabClass } from "@/components/ui/page-tabs"
import { ContentHeader } from "@/components/ui/content-header"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { InboxSidebar } from "@/components/inbox/inbox-sidebar"
import { callDayLabel, callMatches } from "@/lib/calls"
import {
  createSimulatedCalls,
  readSimulatedCall,
  saveSimulatedCall,
} from "@/lib/calls-demo"
import {
  generateCallRecap,
  loadCall,
  loadCalls,
  syncMeetingCalls,
} from "@/lib/calls-state"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/option-select"
import { IssueIcon } from "@/components/issues/issue-controls"
import { cn } from "@/lib/utils"

export function CallsPage({
  initialDirectory,
  teams,
  teamId,
  creator,
  selectedId,
  connectionStatus,
  onSelect,
  simulateWhenEmpty = false,
  scope,
}: {
  initialDirectory: CallsDirectory
  teams: Array<TeamSummary>
  teamId?: string
  creator: string
  selectedId?: string
  connectionStatus?: string
  onSelect: (id?: string) => void
  simulateWhenEmpty?: boolean
  scope?: InboxScope
}) {
  const [directory, setDirectory] = useState(initialDirectory)
  const [sampleCalls, setSampleCalls] = useState(() =>
    simulateWhenEmpty ? createSimulatedCalls(teams) : []
  )
  useEffect(() => {
    if (simulateWhenEmpty)
      setSampleCalls(
        createSimulatedCalls(teams).map((call) =>
          readSimulatedCall(call, creator)
        )
      )
  }, [simulateWhenEmpty, teams, creator])
  const simulated =
    simulateWhenEmpty && !directory.calls.length && sampleCalls.length > 0
  const calls = simulated ? sampleCalls : directory.calls
  function changeSimulatedCall(call: CallRecord) {
    setSampleCalls((current) =>
      current.map((item) => (item.id === call.id ? call : item))
    )
    setDetail(call)
    try {
      saveSimulatedCall(call, creator)
    } catch {
      toast.error("This change could not be saved in your browser.")
    }
  }
  const [detail, setDetail] = useState<CallRecord>()
  const [detailError, setDetailError] = useState("")
  const [query, setQuery] = useState("")
  const [searchOpen, setSearchOpen] = useState(false)
  const searchButton = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())
  const [teamFilter, setTeamFilter] = useState(teamId ?? "all")
  const [filter, setFilter] = useState("all")
  const [connectOpen, setConnectOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [generatingId, setGeneratingId] = useState("")
  useEffect(() => {
    setDirectory(initialDirectory)
  }, [initialDirectory])
  const teamCalls = calls.filter(
    (call) => teamFilter === "all" || call.teamId === teamFilter
  )
  const visible = teamCalls.filter(
    (call) =>
      callMatches(call, query) &&
      (filter !== "actions" || call.actions.some((action) => !action.completed))
  )
  const activeId = selectedId ?? visible[0]?.id
  const selectedTeam = teams.find(
    (team) =>
      team.id ===
      (detail?.teamId ?? calls.find((call) => call.id === activeId)?.teamId)
  )
  const groups = new Map<string, Array<CallRecord>>()
  visible.forEach((call) => {
    const label = callDayLabel(call.startedAt)
    groups.set(label, [...(groups.get(label) ?? []), call])
  })
  const refresh = useCallback(async () => {
    setDirectory(await loadCalls({ data: { teamId } }))
    setRefreshVersion((version) => version + 1)
  }, [teamId])
  useEffect(() => {
    if (!activeId) {
      setDetail(undefined)
      return
    }
    let cancelled = false
    setDetail((current) => (current?.id === activeId ? current : undefined))
    setDetailError("")
    if (simulated) {
      const call = sampleCalls.find((item) => item.id === activeId)
      if (call && (!teamId || call.teamId === teamId)) setDetail(call)
      else setDetailError("This sample call is not available to your team.")
      return
    }
    void loadCall({ data: { callId: activeId } })
      .then((call) => {
        if (!cancelled) {
          if (teamId && call.teamId !== teamId)
            setDetailError("This call belongs to another team.")
          else setDetail(call)
        }
      })
      .catch(() => {
        if (!cancelled)
          setDetailError(
            "This call could not be loaded. It may no longer be available to your team."
          )
      })
    return () => {
      cancelled = true
    }
  }, [activeId, refreshVersion, teamId, simulated, sampleCalls])
  useEffect(() => {
    if (simulated) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh().catch(() => {})
    }, 60000)
    return () => window.clearInterval(timer)
  }, [refresh, simulated])
  async function sync() {
    setSyncing(true)
    try {
      const count = await syncMeetingCalls()
      await refresh()
      toast.success(
        count
          ? `${count} new ${count === 1 ? "call" : "calls"} imported.`
          : "You’re up to date. Transcripts still processing will arrive on a later sync."
      )
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Calls could not be synced."
      )
      await refresh().catch(() => {})
    } finally {
      setSyncing(false)
    }
  }
  async function imported(id: string) {
    await refresh()
    onSelect(id)
    setGeneratingId(id)
    try {
      await generateCallRecap({ data: { callId: id } })
    } catch {
      toast.error(
        "Call imported. The recap could not be generated; you can retry from Summary."
      )
    } finally {
      setGeneratingId("")
      await refresh()
    }
  }
  const hasCalls = calls.length > 0
  const ownedConnection = directory.connections.some(
    (item) => item.connected && item.isOwner
  )
  const hasConnection = directory.connections.some((item) => item.connected)
  const emptyHeader = (
    <ContentHeader className="justify-between">
      <div className="flex items-center gap-2">
        <h1 className="text-[13px] font-medium">Calls</h1>
        {simulated && (
          <span
            title="Fictional meetings. Notes and action changes are saved in this browser."
            className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
          >
            Simulated data
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        {hasCalls && (
          <Button
            size="sm"
            variant="outline"
            disabled={!ownedConnection || syncing}
            onClick={() => void sync()}
          >
            <IssueIcon
              name="repeat"
              className={
                syncing ? "animate-spin motion-reduce:animate-none" : ""
              }
            />
            {syncing ? "Syncing…" : "Sync"}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          aria-label="Meeting connections and privacy"
          onClick={() => setConnectOpen(true)}
        >
          <IssueIcon name="settings" />
          <span className="hidden sm:inline">Connections</span>
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!teams.length}
          onClick={() => setImportOpen(true)}
        >
          <IssueIcon name="add" />
          Import call
        </Button>
      </div>
    </ContentHeader>
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!hasCalls && emptyHeader}
      {connectionStatus && (
        <div
          role="status"
          className={cn(
            "flex items-center justify-between gap-3 border-b border-border/50 px-5 py-3 text-xs",
            connectionStatus === "connected"
              ? "bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
              : "bg-destructive/5 text-destructive"
          )}
        >
          {connectionStatus === "connected"
            ? "Meeting account connected. Sync now to import available transcripts."
            : "The meeting account could not be connected. Check permissions and try again."}
          {connectionStatus === "connected" && (
            <Button
              variant="outline"
              size="xs"
              disabled={syncing}
              onClick={() => void sync()}
            >
              {syncing ? "Syncing…" : "Sync calls"}
            </Button>
          )}
        </div>
      )}
      {!hasCalls ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-8 py-10 pb-12">
          <div className="empty-state-content w-[350px] max-w-full">
            <EmptyStateArt kind="calls" />
            <h2 className="mt-6 text-sm font-medium">Calls</h2>
            <p className="mt-2 text-[13px] leading-[1.5] text-muted-foreground">
              Keep your team’s conversations, decisions, and follow-ups
              together. Connect a meeting tool or import a transcript to get
              started.
            </p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Button
                size="sm"
                className="text-xs"
                onClick={() =>
                  hasConnection && ownedConnection
                    ? void sync()
                    : setConnectOpen(true)
                }
                disabled={syncing}
              >
                <IssueIcon name={hasConnection ? "repeat" : "add"} />
                {syncing
                  ? "Syncing…"
                  : hasConnection && ownedConnection
                    ? "Sync calls"
                    : "Connect a meeting tool"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="text-xs"
                disabled={!teams.length}
                onClick={() => setImportOpen(true)}
              >
                Import a transcript
              </Button>
            </div>
            {directory.connections.some((item) => item.error) && (
              <p
                role="alert"
                className="mt-4 text-center text-xs text-destructive"
              >
                A meeting connection needs attention. Open Connections to review
                it.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <InboxSidebar
            scope={
              scope ?? { workspaceId: teamId ?? "workspace", userId: creator }
            }
            selected={Boolean(selectedId)}
            label="Recent calls"
            storageNamespace="calls"
            resizeLabel="Resize calls sidebar"
          >
            <ContentHeader>
              <h1 className="text-[13px] font-medium">Calls</h1>
              {simulated && (
                <span
                  title="Fictional meetings. Changes are saved in this browser."
                  className="truncate rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                >
                  Simulated data
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                <ActionIconButton
                  ref={searchButton}
                  label="Search calls"
                  aria-pressed={searchOpen}
                  onClick={() => {
                    setSearchOpen(!searchOpen)
                    if (searchOpen) {
                      setQuery("")
                      if (query) onSelect(undefined)
                    }
                  }}
                >
                  <IssueIcon name="search" />
                </ActionIconButton>
                {ownedConnection && (
                  <ActionIconButton
                    label={syncing ? "Syncing calls" : "Sync calls"}
                    disabled={syncing}
                    onClick={() => void sync()}
                  >
                    <IssueIcon
                      name="repeat"
                      className={
                        syncing ? "animate-spin motion-reduce:animate-none" : ""
                      }
                    />
                  </ActionIconButton>
                )}
                <ActionIconButton
                  label="Meeting connections and privacy"
                  onClick={() => setConnectOpen(true)}
                >
                  <IssueIcon name="settings" />
                </ActionIconButton>
                <ActionIconButton
                  label="Import call"
                  disabled={!teams.length}
                  onClick={() => setImportOpen(true)}
                >
                  <IssueIcon name="add" />
                </ActionIconButton>
              </div>
            </ContentHeader>
            <div className="space-y-2 border-b border-border/40 px-3 py-2">
              <PageTabs aria-label="Call views" className="gap-1">
                {(["all", "actions"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setFilter(value)
                      onSelect(undefined)
                    }}
                    aria-pressed={filter === value}
                    className={cn(pageTabClass, "gap-1.5 px-2 text-[11px]")}
                  >
                    {value === "all" ? "All calls" : "With open actions"}
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      {value === "all"
                        ? teamCalls.length
                        : teamCalls.filter((call) =>
                            call.actions.some((action) => !action.completed)
                          ).length}
                    </span>
                  </button>
                ))}
              </PageTabs>
              {!teamId && (
                <OptionSelect
                  aria-label="Filter calls by team"
                  value={teamFilter}
                  onValueChange={(value) => {
                    setTeamFilter(value)
                    onSelect(undefined)
                  }}
                  size="sm"
                  className="w-full bg-transparent text-xs text-muted-foreground hover:bg-muted/50"
                >
                  <option value="all">All teams</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </OptionSelect>
              )}
              {searchOpen && (
                <Input
                  autoFocus
                  type="search"
                  aria-label="Search calls"
                  placeholder="Search calls…"
                  className="h-8 text-xs"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    onSelect(undefined)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setSearchOpen(false)
                      setQuery("")
                      if (query) onSelect(undefined)
                      searchButton.current?.focus()
                    }
                  }}
                />
              )}
            </div>
            <div
              aria-label="Call list"
              className="min-h-0 flex-1 overflow-y-auto p-2"
            >
              {[...groups.entries()].map(([label, items]) => (
                <section key={label}>
                  <h2 className="px-2.5 pt-3 pb-2 text-[11px] font-medium text-muted-foreground">
                    {label}
                  </h2>
                  {items.map((call) => {
                    const openActions = call.actions.filter(
                      (action) => !action.completed
                    ).length
                    return (
                      <button
                        key={call.id}
                        ref={(node) => {
                          if (node) rowRefs.current.set(call.id, node)
                          else rowRefs.current.delete(call.id)
                        }}
                        type="button"
                        aria-label={`Open call: ${call.title}`}
                        aria-pressed={call.id === activeId}
                        onClick={() => onSelect(call.id)}
                        onKeyDown={(event) => {
                          const index = visible.findIndex(
                            (item) => item.id === call.id
                          )
                          const nextIndex =
                            event.key === "ArrowDown"
                              ? Math.min(index + 1, visible.length - 1)
                              : event.key === "ArrowUp"
                                ? Math.max(index - 1, 0)
                                : event.key === "Home"
                                  ? 0
                                  : event.key === "End"
                                    ? visible.length - 1
                                    : undefined
                          if (nextIndex === undefined) return
                          event.preventDefault()
                          const next = visible[nextIndex]
                          onSelect(next.id)
                          const node = rowRefs.current.get(next.id)
                          node?.focus()
                        }}
                        className={cn(
                          "group mb-0.5 flex w-full items-start gap-3 rounded-lg px-2.5 py-3 text-left transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none",
                          call.id === activeId && "bg-muted/70"
                        )}
                      >
                        <ProviderMark
                          provider={call.provider}
                          className="mt-0.5 size-8 rounded-full border-0 bg-muted text-[11px]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-[13px] leading-5 font-medium">
                              {call.title}
                            </span>
                            <time
                              dateTime={call.startedAt}
                              title={new Date(call.startedAt).toLocaleString()}
                              className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
                            >
                              {new Date(call.startedAt).toLocaleTimeString(
                                undefined,
                                { hour: "2-digit", minute: "2-digit" }
                              )}
                            </time>
                          </span>
                          <span className="mt-0.5 block truncate text-xs leading-5 text-muted-foreground">
                            {call.summary ||
                              (call.status === "expired"
                                ? "Transcript retention reached"
                                : call.summaryStatus === "error"
                                  ? "Recap needs another try"
                                  : "Ready for a recap")}
                          </span>
                          <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                            <span
                              className="min-w-0 flex-1 truncate"
                              title={call.participants.join(", ")}
                            >
                              {!teamId
                                ? (teams.find((team) => team.id === call.teamId)
                                    ?.name ?? "Team")
                                : `${call.participants[0] ?? "No participants"}${call.participants.length > 1 ? ` +${call.participants.length - 1}` : ""}`}
                              {call.duration > 0 && ` · ${call.duration} min`}
                            </span>
                            {openActions > 0 && (
                              <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
                                <IssueIcon name="check" className="size-3" />
                                {openActions} open
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </section>
              ))}
              {!visible.length && (
                <div className="px-5 py-16 text-center">
                  <IssueIcon
                    name="search"
                    className="mx-auto mb-3 size-5 text-muted-foreground"
                  />
                  <h2 className="text-sm font-medium">No matching calls</h2>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    Try a different search or team, or include calls without
                    open actions.
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="mt-3"
                    onClick={() => {
                      setQuery("")
                      setFilter("all")
                      setTeamFilter(teamId ?? "all")
                      onSelect(undefined)
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              )}
            </div>
            <div className="border-t border-border/50 p-3">
              <button
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => setConnectOpen(true)}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    hasConnection ? "bg-emerald-500" : "bg-muted-foreground/50"
                  )}
                />
                {hasConnection
                  ? "Meeting connections"
                  : "Connect your meeting tool"}
                <IssueIcon name="settings" className="ml-auto size-3" />
              </button>
            </div>
          </InboxSidebar>
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col md:flex",
              selectedId ? "flex" : "hidden"
            )}
          >
            {generatingId && generatingId === activeId && (
              <p
                role="status"
                className="flex items-center gap-2 border-b border-border/50 bg-muted/30 px-8 py-3 text-xs text-muted-foreground"
              >
                <IssueIcon name="spark" />
                Generating your recap and next actions…
              </p>
            )}
            {detailError ? (
              <div role="alert" className="m-auto max-w-sm p-8 text-center">
                <p className="text-[13px] leading-6 text-muted-foreground">
                  {detailError}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => setRefreshVersion((version) => version + 1)}
                >
                  Try again
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-4 lg:hidden"
                  onClick={() => onSelect(undefined)}
                >
                  Back to calls
                </Button>
              </div>
            ) : detail && selectedTeam ? (
              <CallDetail
                key={detail.id}
                call={detail}
                team={selectedTeam}
                creator={creator}
                retentionDays={directory.retentionDays}
                onRefresh={refresh}
                onSimulatedChange={simulated ? changeSimulatedCall : undefined}
                onBack={() => onSelect(undefined)}
              />
            ) : activeId ? (
              <div role="status" className="space-y-5 p-8">
                <div className="h-4 w-36 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                <div className="h-7 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
                <div className="h-32 animate-pulse rounded-xl bg-muted/50 motion-reduce:animate-none" />
                <span className="sr-only">Loading call…</span>
              </div>
            ) : (
              <div className="m-auto max-w-sm p-8 text-center">
                <HugeiconsIcon
                  icon={Call02Icon}
                  className="mx-auto mb-4 size-6 text-muted-foreground"
                />
                <p className="text-sm text-muted-foreground">
                  Choose a call to catch up on the conversation.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
      {connectOpen && (
        <ConnectCallsDialog
          open
          onOpenChange={setConnectOpen}
          directory={directory}
          teams={teams}
          teamId={teamId}
          onChanged={refresh}
        />
      )}
      {importOpen && (
        <ImportCallDialog
          open
          onOpenChange={setImportOpen}
          teams={teams}
          teamId={teamId}
          onImported={imported}
        />
      )}
    </div>
  )
}
