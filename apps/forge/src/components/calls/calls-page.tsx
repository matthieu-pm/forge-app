import { useCallback, useEffect, useState } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Call02Icon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"
import { CallDetail } from "./call-detail"
import {
  ConnectCallsDialog,
  ImportCallDialog,
  ProviderMark,
  callField,
} from "./call-dialogs"
import type { CallRecord, CallsDirectory } from "@/lib/calls"
import type { TeamSummary } from "@/lib/team-contract"
import { callDayLabel, callMatches } from "@/lib/calls"
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
}: {
  initialDirectory: CallsDirectory
  teams: Array<TeamSummary>
  teamId?: string
  creator: string
  selectedId?: string
  connectionStatus?: string
  onSelect: (id?: string) => void
}) {
  const [directory, setDirectory] = useState(initialDirectory)
  const [detail, setDetail] = useState<CallRecord>()
  const [detailError, setDetailError] = useState("")
  const [query, setQuery] = useState("")
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
  const visible = directory.calls.filter(
    (call) =>
      (teamFilter === "all" || call.teamId === teamFilter) &&
      callMatches(call, query) &&
      (filter !== "actions" || call.actions.some((action) => !action.completed))
  )
  const activeId = selectedId ?? visible[0]?.id
  const selectedTeam = teams.find(
    (team) =>
      team.id ===
      (detail?.teamId ??
        directory.calls.find((call) => call.id === activeId)?.teamId)
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
  }, [activeId, refreshVersion, teamId])
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh().catch(() => {})
    }, 60000)
    return () => window.clearInterval(timer)
  }, [refresh])
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
  const hasCalls = directory.calls.length > 0
  const ownedConnection = directory.connections.some(
    (item) => item.connected && item.isOwner
  )
  const hasConnection = directory.connections.some((item) => item.connected)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-3 border-y border-border/60 px-5 py-2">
        <div className="flex items-center gap-5">
          <button
            type="button"
            onClick={() => setFilter("all")}
            aria-pressed={filter === "all"}
            className={cn(
              "flex items-center gap-2 text-[13px] font-medium",
              filter !== "all" && "text-muted-foreground"
            )}
          >
            All calls
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tabular-nums">
              {directory.calls.length}
            </span>
          </button>
          <button
            type="button"
            onClick={() => setFilter("actions")}
            aria-pressed={filter === "actions"}
            className={cn(
              "text-[13px] font-medium",
              filter !== "actions" && "text-muted-foreground"
            )}
          >
            With open actions
          </button>
        </div>
        <div className="flex items-center gap-2">
          {hasCalls && (
            <Button
              size="sm"
              variant="ghost"
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
            variant="ghost"
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
      </div>
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
        <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-12">
          <div className="w-full max-w-lg">
            <div className="relative mb-8 flex h-24 items-center justify-center">
              <div
                aria-hidden="true"
                className="absolute h-20 w-56 rounded-full bg-muted/50 blur-xl"
              />
              <ProviderMark
                provider="google"
                className="relative size-12 -rotate-12 rounded-2xl text-xl shadow-sm"
              />
              <span
                aria-hidden="true"
                className="relative z-10 -mx-1 mb-4 flex size-16 items-center justify-center rounded-[20px] border border-border/60 bg-background shadow-sm"
              >
                <HugeiconsIcon
                  icon={Call02Icon}
                  className="size-6"
                  strokeWidth={1.5}
                />
              </span>
              <ProviderMark
                provider="zoom"
                className="relative size-12 rotate-12 rounded-2xl text-xl shadow-sm"
              />
            </div>
            <div className="text-center">
              <h1 className="text-2xl font-semibold tracking-tight">
                Good conversations deserve a next step.
              </h1>
              <p className="mx-auto mt-3 max-w-sm text-[13px] leading-6 text-muted-foreground">
                Keep your{" "}
                {teamId
                  ? `${teams.find((team) => team.id === teamId)?.name ?? "team"} team’s`
                  : "team’s"}{" "}
                calls, decisions, and follow-ups together. Turn the next good
                idea into tracked work.
              </p>
            </div>
            <div className="mt-8 space-y-5 border-y border-border/60 py-6">
              {[
                {
                  number: "01",
                  title: "Connect the tool you already use",
                  text: "Google Meet, Microsoft Teams, or Zoom. No bot in your meeting.",
                },
                {
                  number: "02",
                  title: "Catch up in a minute",
                  text: "Native transcripts become short recaps, decisions, and action items.",
                },
                {
                  number: "03",
                  title: "Take the conversation forward",
                  text: "Add context with team notes, then turn an action into a Forge issue.",
                },
              ].map((step) => (
                <div key={step.number} className="flex gap-4">
                  <span className="pt-0.5 text-[11px] text-muted-foreground/65 tabular-nums">
                    {step.number}
                  </span>
                  <div>
                    <p className="text-[13px] font-medium">{step.title}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {step.text}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <Button
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
                variant="ghost"
                disabled={!teams.length}
                onClick={() => setImportOpen(true)}
              >
                Import a transcript
              </Button>
            </div>
            <p className="mt-5 text-center text-[11px] leading-5 text-muted-foreground">
              Participants must be informed before transcription.
              <br />
              Transcripts are kept for {directory.retentionDays} days. Admins
              can change this in Connections.
            </p>
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
          <aside
            aria-label="Recent calls"
            className={cn(
              "min-h-0 w-full shrink-0 flex-col border-r border-border/60 lg:flex lg:w-80 xl:w-[360px]",
              selectedId ? "hidden" : "flex"
            )}
          >
            <div className="space-y-2 border-b border-border/50 px-4 py-3">
              <div className="relative">
                <IssueIcon
                  name="search"
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  aria-label="Search calls"
                  placeholder="Search calls…"
                  className={cn(callField, "bg-muted/25 pl-9")}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              {!teamId && (
                <OptionSelect
                  aria-label="Filter calls by team"
                  value={teamFilter}
                  onValueChange={(value) => {
                    setTeamFilter(value)
                    onSelect(undefined)
                  }}
                  size="sm"
                  className="w-full bg-transparent text-muted-foreground hover:bg-muted/50"
                >
                  <option value="all">All teams</option>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </OptionSelect>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
              {[...groups.entries()].map(([label, items]) => (
                <section key={label}>
                  <h2 className="px-3 pt-5 pb-2 text-[11px] font-medium text-muted-foreground">
                    {label}
                  </h2>
                  <div className="space-y-1">
                    {items.map((call) => (
                      <button
                        type="button"
                        aria-current={call.id === activeId ? "true" : undefined}
                        key={call.id}
                        onClick={() => onSelect(call.id)}
                        className={cn(
                          "group w-full rounded-xl border border-transparent p-3 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring",
                          call.id === activeId && "border-border/40 bg-muted/60"
                        )}
                      >
                        <div className="mb-2 flex items-center gap-2">
                          <ProviderMark
                            provider={call.provider}
                            className="size-5 rounded-md text-[10px]"
                          />
                          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                            {teams.find((team) => team.id === call.teamId)
                              ?.name ?? "Team"}
                          </span>
                          <time
                            dateTime={call.startedAt}
                            className="text-[11px] text-muted-foreground tabular-nums"
                          >
                            {new Date(call.startedAt).toLocaleTimeString(
                              undefined,
                              { hour: "2-digit", minute: "2-digit" }
                            )}
                          </time>
                        </div>
                        <h3 className="line-clamp-2 text-[13px] leading-5 font-medium">
                          {call.title}
                        </h3>
                        <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                          {call.summary ||
                            (call.status === "expired"
                              ? "Transcript retention reached"
                              : call.summaryStatus === "error"
                                ? "Recap needs another try"
                                : "Ready for a recap")}
                        </p>
                        <div className="mt-3 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                          <span className="truncate">
                            {call.participants.slice(0, 2).join(", ")}
                            {call.participants.length > 2
                              ? ` +${call.participants.length - 2}`
                              : ""}
                          </span>
                          {call.actions.some((item) => !item.completed) && (
                            <span className="shrink-0 rounded-md bg-background/75 px-1.5 py-0.5">
                              {
                                call.actions.filter((item) => !item.completed)
                                  .length
                              }{" "}
                              open actions
                            </span>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
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
          </aside>
          <div
            className={cn(
              "min-h-0 min-w-0 flex-1 flex-col lg:flex",
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
