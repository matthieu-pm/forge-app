import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { toast } from "sonner"
import { Link01Icon } from "@hugeicons/core-free-icons"
import { ProviderMark, callField } from "./call-dialogs"
import type { CallRecord } from "@/lib/calls"
import type { TeamSummary } from "@/lib/team-contract"
import { pageTabClass } from "@/components/ui/page-tabs"
import { ContentHeader } from "@/components/ui/content-header"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { timestampLabel } from "@/lib/calls"
import { addNote, generateCallRecap, updateCallAction } from "@/lib/calls-state"
import { callActionSource, createCallIssue } from "@/lib/call-issues"
import { useIssueStore } from "@/lib/team-issues"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/option-select"
import { Textarea } from "@/components/ui/textarea"
import { IssueIcon } from "@/components/issues/issue-controls"
import { cn } from "@/lib/utils"

export function CallDetail({
  call,
  team,
  creator,
  retentionDays,
  onRefresh,
  onBack,
  onSimulatedChange,
}: {
  call: CallRecord
  team: TeamSummary
  creator: string
  retentionDays: number
  onRefresh: () => Promise<void>
  onBack: () => void
  onSimulatedChange?: (call: CallRecord) => void
}) {
  const [tab, setTab] = useState<"summary" | "transcript" | "notes">("summary")
  const [query, setQuery] = useState("")
  const [note, setNote] = useState("")
  const [kind, setKind] = useState<"note" | "follow-up">("note")
  const [busy, setBusy] = useState("")
  const { store, error: issueError } = useIssueStore(team.id)
  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key)
    try {
      await action()
      if (!onSimulatedChange) await onRefresh()
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not save this change."
      )
    } finally {
      setBusy("")
    }
  }
  const entries = call.transcript.filter((entry) =>
    `${entry.speaker} ${entry.text}`.toLowerCase().includes(query.toLowerCase())
  )
  return (
    <article
      aria-label={call.title}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <ContentHeader>
        <Button
          className="md:hidden"
          variant="ghost"
          size="sm"
          onClick={onBack}
        >
          ← All calls
        </Button>
        <span className="hidden items-center gap-2 text-xs text-muted-foreground md:flex">
          <ProviderMark
            provider={call.provider}
            className="size-5 rounded-md text-[10px]"
          />
          {onSimulatedChange
            ? "Simulated meeting"
            : call.provider === "upload"
              ? "Imported transcript"
              : "Native transcript"}
        </span>
        <ActionIconButton
          className="ml-auto"
          label="Copy call link"
          icon={Link01Icon}
          onClick={() => {
            void navigator.clipboard
              .writeText(
                new URL(
                  `/workspace/calls?call=${call.id}`,
                  window.location.origin
                ).href
              )
              .then(
                () => toast.success("Call link copied."),
                () => toast.error("Could not copy the call link.")
              )
          }}
        />
      </ContentHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-12 lg:px-8">
        <header className="pt-6 pb-5">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-md bg-muted px-2 py-1 text-foreground/75">
              {team.name}
            </span>
            <span>·</span>
            <time dateTime={call.startedAt}>
              {new Date(call.startedAt).toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
            </time>
            <span>·</span>
            <span>
              {new Date(call.startedAt).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
            {call.duration > 0 && (
              <>
                <span>·</span>
                <span>{call.duration} min</span>
              </>
            )}
          </div>
          <h1 className="max-w-3xl text-2xl leading-tight font-semibold tracking-tight xl:text-[28px]">
            {call.title}
          </h1>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <div className="flex -space-x-1.5">
              {call.participants.slice(0, 5).map((name, index) => (
                <span
                  title={name}
                  key={`${name}-${index}`}
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full border-2 border-background text-[9px] font-medium",
                    [
                      "bg-sky-100 text-sky-800",
                      "bg-amber-100 text-amber-800",
                      "bg-emerald-100 text-emerald-800",
                      "bg-rose-100 text-rose-800",
                    ][index % 4]
                  )}
                >
                  {name
                    .split(" ")
                    .map((part) => part[0])
                    .slice(0, 2)
                    .join("")}
                </span>
              ))}
            </div>
            <span className="text-xs text-muted-foreground">
              {call.participants.join(", ") || "No participants listed"}
            </span>
          </div>
        </header>
        <div
          role="tablist"
          aria-label="Call content"
          className="sticky top-0 z-10 flex gap-1.5 border-b border-border/60 bg-background py-2"
        >
          {(["summary", "transcript", "notes"] as const).map((value) => (
            <button
              role="tab"
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onKeyDown={(event) => {
                const tabs = ["summary", "transcript", "notes"] as const
                const index = tabs.indexOf(value)
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % 3
                    : event.key === "ArrowLeft"
                      ? (index + 2) % 3
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? 2
                          : -1
                if (next < 0) return
                event.preventDefault()
                setTab(tabs[next])
                document
                  .getElementById(`call-tab-${call.id}-${tabs[next]}`)
                  ?.focus()
              }}
              aria-controls={`call-panel-${call.id}`}
              id={`call-tab-${call.id}-${value}`}
              key={value}
              onClick={() => setTab(value)}
              className={pageTabClass}
            >
              {value === "summary"
                ? "Summary"
                : value === "transcript"
                  ? "Transcript"
                  : "Notes"}
              {value === "notes" && call.notes.length > 0 && (
                <span className="rounded bg-muted px-1.5 text-[10px]">
                  {call.notes.length}
                </span>
              )}
            </button>
          ))}
        </div>
        <div
          role="tabpanel"
          id={`call-panel-${call.id}`}
          aria-labelledby={`call-tab-${call.id}-${tab}`}
          className="pt-6"
        >
          {tab === "summary" && (
            <div className="space-y-6">
              {call.summaryStatus === "ready" ? (
                <>
                  <section>
                    <div className="mb-3 flex items-center gap-2">
                      <IssueIcon
                        name="spark"
                        className="text-muted-foreground"
                      />
                      <h2 className="text-sm font-medium">At a glance</h2>
                    </div>
                    <p className="text-[13px] leading-7 whitespace-pre-wrap text-foreground/80">
                      {call.summary}
                    </p>
                    <p className="mt-3 text-[11px] text-muted-foreground">
                      {onSimulatedChange
                        ? "Sample recap and transcript. This meeting is fictional."
                        : "AI-generated. Check important details against the transcript."}
                    </p>
                  </section>
                  <section>
                    <h2 className="mb-3 text-sm font-medium">Decisions</h2>
                    {call.decisions.length ? (
                      <ul className="space-y-3">
                        {call.decisions.map((decision, index) => (
                          <li
                            key={index}
                            className="flex gap-3 text-[13px] leading-6 text-foreground/80"
                          >
                            <IssueIcon
                              name="check"
                              className="mt-1 text-emerald-600"
                            />
                            <span>{decision}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[13px] text-muted-foreground">
                        No explicit decisions were identified in this call.
                      </p>
                    )}
                  </section>
                </>
              ) : (
                <div className="rounded-xl border border-dashed border-border p-5">
                  <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <IssueIcon name="spark" />
                    {call.status === "pending"
                      ? "Waiting for a transcript"
                      : call.status === "expired"
                        ? "Transcript retention reached"
                        : call.summaryStatus === "error"
                          ? "Recap needs another try"
                          : "Your transcript is ready"}
                  </div>
                  <p className="text-[13px] leading-6 text-muted-foreground">
                    {call.status === "pending"
                      ? "Your provider is still preparing the transcript. It will appear after the next sync."
                      : call.status === "expired"
                        ? "The transcript was removed according to your workspace’s retention policy."
                        : "Generate a short recap with decisions and suggested action items."}
                  </p>
                  {call.status === "ready" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-4"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void run("summary", () =>
                          generateCallRecap({ data: { callId: call.id } })
                        )
                      }
                    >
                      {busy === "summary"
                        ? "Generating recap…"
                        : call.summaryStatus === "error"
                          ? "Retry recap"
                          : "Generate recap"}
                    </Button>
                  )}
                </div>
              )}
              <section>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-sm font-medium">Action items</h2>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {call.actions.filter((item) => item.completed).length} /{" "}
                    {call.actions.length} done
                  </span>
                </div>
                {issueError && (
                  <p role="alert" className="mb-3 text-xs text-destructive">
                    {issueError}
                  </p>
                )}
                {call.actions.length ? (
                  <div className="divide-y divide-border/50 rounded-xl border border-border/60 px-4">
                    {call.actions.map((action) => {
                      const issue =
                        typeof window !== "undefined"
                          ? store.issues.find((item) =>
                              item.links.some(
                                (link) =>
                                  link.url ===
                                  callActionSource(
                                    call.id,
                                    action.id,
                                    window.location.origin
                                  )
                              )
                            )
                          : undefined
                      return (
                        <div
                          key={action.id}
                          id={`action-${action.id}`}
                          className="grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 py-3.5 sm:grid-cols-[1rem_minmax(0,1fr)_auto]"
                        >
                          <Checkbox
                            id={`call-action-${action.id}`}
                            checked={action.completed}
                            aria-labelledby={`call-action-label-${action.id}`}
                            disabled={Boolean(busy)}
                            onCheckedChange={(checked) =>
                              void run(action.id, async () => {
                                if (onSimulatedChange) {
                                  onSimulatedChange({
                                    ...call,
                                    actions: call.actions.map((item) =>
                                      item.id === action.id
                                        ? { ...item, completed: checked }
                                        : item
                                    ),
                                  })
                                  return
                                }
                                await updateCallAction({
                                  data: {
                                    callId: call.id,
                                    actionId: action.id,
                                    completed: checked,
                                  },
                                })
                              })
                            }
                            className="mt-0.5"
                          />
                          <div className="min-w-0">
                            <label
                              id={`call-action-label-${action.id}`}
                              htmlFor={`call-action-${action.id}`}
                              className={cn(
                                "block cursor-pointer text-[13px] leading-5",
                                action.completed &&
                                  "text-muted-foreground line-through"
                              )}
                            >
                              {action.title}
                            </label>
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              {action.owner || "Unassigned"}
                            </p>
                          </div>
                          {issue ? (
                            <Link
                              to="/teams/$teamSlug/issues"
                              params={{ teamSlug: team.slug }}
                              search={{ view: "all", issue: issue.id }}
                              className="col-start-2 flex h-6 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground sm:col-start-3 sm:row-start-1"
                            >
                              <IssueIcon name="link" />
                              {team.identifier}-{issue.number}
                            </Link>
                          ) : (
                            <Button
                              variant="ghost"
                              size="xs"
                              className="col-start-2 justify-self-start text-muted-foreground sm:col-start-3 sm:row-start-1"
                              disabled={Boolean(issueError)}
                              onClick={async () => {
                                try {
                                  const created = await createCallIssue(
                                    call,
                                    action,
                                    window.location.origin,
                                    creator
                                  )
                                  toast.success(
                                    `${team.identifier}-${created.number} created with a link to this call.`
                                  )
                                } catch (error) {
                                  toast.error(
                                    error instanceof Error
                                      ? error.message
                                      : "Could not create the issue."
                                  )
                                }
                              }}
                            >
                              <IssueIcon name="add" />
                              Create issue
                            </Button>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-[13px] text-muted-foreground">
                    {call.summaryStatus === "ready"
                      ? "No action items were identified. Add a follow-up in Notes."
                      : "Suggested actions will appear with the recap."}
                  </p>
                )}
              </section>
              {call.notes.some((item) => item.kind === "follow-up") && (
                <section>
                  <h2 className="mb-3 text-sm font-medium">Follow-ups</h2>
                  {call.notes
                    .filter((item) => item.kind === "follow-up")
                    .map((item) => (
                      <p
                        key={item.id}
                        className="mb-3 border-l-2 border-border pl-3 text-[13px] leading-6 whitespace-pre-wrap"
                      >
                        {item.body}
                        <span className="mt-1 block text-[11px] text-muted-foreground">
                          {item.author}
                        </span>
                      </p>
                    ))}
                </section>
              )}
            </div>
          )}
          {tab === "transcript" && (
            <section>
              {call.status === "expired" ? (
                <div className="rounded-xl bg-muted/50 p-5">
                  <h2 className="mb-2 text-sm font-medium">
                    Transcript removed
                  </h2>
                  <p className="text-[13px] leading-6 text-muted-foreground">
                    Your workspace keeps transcripts for {retentionDays} days
                    from the call date. The recap and team notes are still
                    available.
                  </p>
                </div>
              ) : !call.transcript.length ? (
                <p className="text-[13px] text-muted-foreground">
                  No transcript yet. Sync after your meeting provider has
                  finished processing it.
                </p>
              ) : (
                <>
                  <div className="relative mb-6">
                    <IssueIcon
                      name="search"
                      className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      aria-label="Search transcript"
                      placeholder="Search this transcript…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      className={cn(callField, "pl-9")}
                    />
                  </div>
                  <p className="mb-5 text-[11px] text-muted-foreground">
                    {entries.length} passages ·{" "}
                    {onSimulatedChange
                      ? "Fictional conversation"
                      : "Transcription notice managed by the meeting host"}
                  </p>
                  <div className="space-y-6">
                    {entries.map((entry, index) => (
                      <div
                        key={index}
                        className="grid grid-cols-[42px_1fr] gap-3"
                      >
                        <span className="pt-0.5 text-xs text-muted-foreground tabular-nums">
                          {timestampLabel(entry.seconds)}
                        </span>
                        <div>
                          <p className="mb-1 text-xs font-medium">
                            {entry.speaker}
                          </p>
                          <p className="text-[13px] leading-7 whitespace-pre-wrap text-foreground/80">
                            {entry.text}
                          </p>
                        </div>
                      </div>
                    ))}
                    {!entries.length && (
                      <p className="text-[13px] text-muted-foreground">
                        No passages match “{query}”.
                      </p>
                    )}
                  </div>
                </>
              )}
            </section>
          )}
          {tab === "notes" && (
            <section>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void run("note", async () => {
                    if (onSimulatedChange)
                      onSimulatedChange({
                        ...call,
                        notes: [
                          {
                            id: crypto.randomUUID(),
                            body: note.trim(),
                            kind,
                            author: "You",
                            createdAt: new Date().toISOString(),
                          },
                          ...call.notes,
                        ],
                      })
                    else
                      await addNote({
                        data: { callId: call.id, body: note, kind },
                      })
                    setNote("")
                  })
                }}
                className="mb-6 overflow-hidden rounded-xl border border-border/60 bg-muted/20 p-3"
              >
                <label className="sr-only" htmlFor={`note-${call.id}`}>
                  Add a note or follow-up
                </label>
                <Textarea
                  id={`note-${call.id}`}
                  rows={4}
                  maxLength={10000}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add context, ask a question, or capture a follow-up…"
                  className="min-h-28 resize-y rounded-lg bg-transparent px-2 text-[13px] leading-6 md:text-[13px]"
                />
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/50 pt-3">
                  <OptionSelect
                    aria-label="Note type"
                    value={kind}
                    onValueChange={(value) => setKind(value as typeof kind)}
                    size="sm"
                    className="min-w-28 bg-transparent text-muted-foreground hover:bg-muted"
                  >
                    <option value="note">Note</option>
                    <option value="follow-up">Follow-up</option>
                  </OptionSelect>
                  <Button
                    size="sm"
                    type="submit"
                    disabled={!note.trim() || Boolean(busy)}
                  >
                    {busy === "note" ? "Saving…" : "Add note"}
                  </Button>
                </div>
              </form>
              {call.notes.length ? (
                <div className="space-y-6">
                  {call.notes.map((item) => (
                    <div key={item.id}>
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium">{item.author}</span>
                        <time
                          dateTime={item.createdAt}
                          className="text-muted-foreground"
                        >
                          {new Date(item.createdAt).toLocaleDateString(
                            undefined,
                            { month: "short", day: "numeric" }
                          )}
                        </time>
                        {item.kind === "follow-up" && (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            Follow-up
                          </span>
                        )}
                      </div>
                      <p className="text-[13px] leading-7 whitespace-pre-wrap text-foreground/80">
                        {item.body}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-6 text-center">
                  <IssueIcon
                    name="comment"
                    className="mx-auto mb-3 size-5 text-muted-foreground"
                  />
                  <h2 className="text-sm font-medium">
                    Make room for what comes next
                  </h2>
                  <p className="mt-2 text-[13px] text-muted-foreground">
                    Notes and follow-ups are shared with this call’s team.
                  </p>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </article>
  )
}
