import { useState } from "react"
import { toast } from "sonner"
import type { CallsDirectory, MeetingProvider } from "@/lib/calls"
import type { TeamSummary } from "@/lib/team-contract"
import { meetingProviders } from "@/lib/calls"
import {
  connectMeetingProvider,
  disconnectMeetingProvider,
  updateCallRetention,
  uploadCall,
} from "@/lib/calls-state"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/option-select"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { IssueIcon } from "@/components/issues/issue-controls"
import { cn } from "@/lib/utils"

export const callField = "w-full rounded-lg text-[13px] md:text-[13px]"
export function ProviderMark({
  provider,
  className,
}: {
  provider: MeetingProvider | "upload"
  className?: string
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-background text-xs font-semibold",
        className
      )}
    >
      {provider === "upload" ? (
        <IssueIcon name="file" />
      ) : (
        <img
          src={meetingProviders[provider].logo}
          alt=""
          className="size-[65%] object-contain"
        />
      )}
    </span>
  )
}
export function ConnectCallsDialog({
  open,
  onOpenChange,
  directory,
  teams,
  teamId,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  directory: CallsDirectory
  teams: Array<TeamSummary>
  teamId?: string
  onChanged: () => Promise<void>
}) {
  const [selectedTeam, setSelectedTeam] = useState(teamId ?? teams[0]?.id ?? "")
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState("")
  const [days, setDays] = useState(directory.retentionDays)
  async function connect(provider: MeetingProvider) {
    setBusy(provider)
    try {
      window.location.assign(
        await connectMeetingProvider({
          data: { provider, teamId: selectedTeam, consentConfirmed: true },
        })
      )
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not connect this meeting provider."
      )
      setBusy("")
    }
  }
  async function disconnect(id: string) {
    setBusy(id)
    try {
      await disconnectMeetingProvider({ data: { id } })
      await onChanged()
      toast.success("Meeting account disconnected. Existing calls are kept.")
    } catch {
      toast.error("Could not disconnect the meeting account.")
    } finally {
      setBusy("")
    }
  }
  async function saveDays() {
    setBusy("retention")
    try {
      await updateCallRetention({ data: { days: days as 7 | 30 | 90 | 365 } })
      await onChanged()
      toast.success("Transcript retention updated.")
    } catch {
      toast.error("Could not update transcript retention.")
    } finally {
      setBusy("")
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] gap-5 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect your conversations</DialogTitle>
          <DialogDescription>
            Bring native meeting transcripts into Forge. No meeting bot joins
            your calls.
          </DialogDescription>
        </DialogHeader>
        {!directory.canManage && (
          <p className="rounded-lg bg-muted p-3 text-[13px] text-muted-foreground">
            Ask a workspace admin to connect a meeting account or change
            transcript retention.
          </p>
        )}
        <div className="space-y-5">
          <label className="flex flex-col gap-2.5 text-[13px] font-medium">
            <span>Import new calls into</span>
            <OptionSelect
              aria-label="Import calls into team"
              className={callField}
              value={selectedTeam}
              onValueChange={setSelectedTeam}
              disabled={!directory.canManage || Boolean(busy)}
            >
              <option value="" disabled>
                Select a team
              </option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </OptionSelect>
          </label>
          <div className="divide-y divide-border/60 rounded-xl border border-border/60 px-4">
            {(Object.keys(meetingProviders) as Array<MeetingProvider>).map(
              (provider) => {
                const connection = directory.connections.find(
                  (item) =>
                    item.provider === provider && item.isOwner && item.connected
                )
                const configured =
                  directory.configuredProviders.includes(provider)
                return (
                  <div key={provider} className="py-4">
                    <div className="flex items-center gap-3">
                      <ProviderMark provider={provider} className="size-9" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium">
                          {meetingProviders[provider].name}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {connection
                            ? `Connected · ${teams.find((t) => t.id === connection.teamId)?.name ?? "Team"}`
                            : configured
                              ? "Ready to connect"
                              : "Administrator setup required"}
                        </p>
                      </div>
                      {connection ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={Boolean(busy) || !directory.canManage}
                          onClick={() => void disconnect(connection.id)}
                        >
                          Disconnect
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            !configured ||
                            !directory.canManage ||
                            !consent ||
                            !selectedTeam ||
                            Boolean(busy)
                          }
                          onClick={() => void connect(provider)}
                        >
                          {busy === provider ? "Connecting…" : "Connect"}
                        </Button>
                      )}
                    </div>
                    <p className="mt-3 text-xs leading-5 text-muted-foreground">
                      {meetingProviders[provider].help}
                    </p>
                    {connection?.error && (
                      <p role="alert" className="mt-2 text-xs text-destructive">
                        {connection.error}
                      </p>
                    )}
                  </div>
                )
              }
            )}
          </div>
          <div className="rounded-xl bg-muted/60 p-4">
            <p className="mb-2 flex items-center gap-2 text-[13px] font-medium">
              <IssueIcon name="person" />
              Everyone stays informed
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              The meeting host must enable the provider’s transcription notice
              and tell participants their transcript will be shared with this
              Forge team and sent to OpenAI for summaries. Forge does not start
              recording or notify meeting attendees itself.
            </p>
            <label className="mt-4 flex cursor-pointer items-start gap-3 text-xs leading-5 has-disabled:cursor-default has-disabled:opacity-50">
              <Checkbox
                checked={consent}
                onCheckedChange={setConsent}
                className="mt-0.5"
                disabled={!directory.canManage}
              />
              I’ll ensure participants are informed before transcription.
            </label>
          </div>
          <div className="border-t border-border/60 pt-4">
            <label
              className="mb-2 block text-[13px] font-medium"
              htmlFor="call-retention"
            >
              Keep transcripts for
            </label>
            <div className="flex items-center gap-2">
              <OptionSelect
                id="call-retention"
                className={callField}
                value={String(days)}
                onValueChange={(value) => setDays(Number(value))}
                disabled={!directory.canManage || Boolean(busy)}
              >
                {[7, 30, 90, 365].map((value) => (
                  <option key={value} value={value}>
                    {value} days
                  </option>
                ))}
              </OptionSelect>
              <Button
                variant="outline"
                disabled={
                  !directory.canManage ||
                  days === directory.retentionDays ||
                  Boolean(busy)
                }
                onClick={() => void saveDays()}
              >
                {busy === "retention" ? "Saving…" : "Save"}
              </Button>
            </div>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Applies across the workspace from the call date. Saving a shorter
              period immediately removes older transcript text. Summaries,
              decisions, notes, and action items are kept. Provider copies
              follow that provider’s policy.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
export function ImportCallDialog({
  open,
  onOpenChange,
  teams,
  teamId,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  teams: Array<TeamSummary>
  teamId?: string
  onImported: (id: string) => Promise<void>
}) {
  const [selectedTeam, setSelectedTeam] = useState(teamId ?? teams[0]?.id ?? "")
  const [title, setTitle] = useState("")
  const [text, setText] = useState("")
  const [date, setDate] = useState(() =>
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16)
  )
  const [consent, setConsent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next)
      }}
    >
      <DialogContent className="max-h-[90dvh] gap-5 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a call</DialogTitle>
          <DialogDescription>
            Add a transcript you already have. Forge will create a recap and
            suggest next actions.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true)
            setError("")
            try {
              const id = await uploadCall({
                data: {
                  teamId: selectedTeam,
                  title,
                  text,
                  startedAt: new Date(date).toISOString(),
                  consentConfirmed: true,
                },
              })
              onOpenChange(false)
              await onImported(id)
              setTitle("")
              setText("")
              setConsent(false)
            } catch (e) {
              setError(
                e instanceof Error ? e.message : "Could not import this call."
              )
            } finally {
              setBusy(false)
            }
          }}
        >
          <label className="flex flex-col gap-2.5 text-[13px]">
            <span>Call title</span>
            <Input
              autoFocus
              required
              maxLength={240}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Product & engineering sync"
              className={callField}
            />
          </label>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-2.5 text-[13px]">
              <span>Team</span>
              <OptionSelect
                required
                className={callField}
                value={selectedTeam}
                onValueChange={setSelectedTeam}
                disabled={Boolean(teamId)}
              >
                <option value="" disabled>
                  Select a team
                </option>
                {teams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </OptionSelect>
            </label>
            <label className="flex flex-col gap-2.5 text-[13px]">
              <span>Call date</span>
              <Input
                required
                type="datetime-local"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={callField}
              />
            </label>
          </div>
          <label className="flex flex-col gap-2.5 text-[13px]">
            <span>
              Transcript file{" "}
              <span className="text-muted-foreground">· VTT, SRT, or TXT</span>
            </span>
            <Input
              type="file"
              accept=".vtt,.srt,.txt"
              className={cn(
                callField,
                "h-auto min-h-8 py-1.5 file:mr-3 file:rounded-md file:bg-background/80 file:px-2 file:text-xs"
              )}
              onChange={async (event) => {
                const file = event.target.files?.[0]
                if (!file) return
                if (file.size > 250000) {
                  setError("Choose a transcript smaller than 250 KB.")
                  return
                }
                try {
                  setText(await file.text())
                  setError("")
                } catch {
                  setError("This file could not be read.")
                }
              }}
            />
          </label>
          <label className="flex flex-col gap-2.5 text-[13px]">
            <span>Or paste transcript text</span>
            <Textarea
              required
              rows={6}
              maxLength={250000}
              className={cn(callField, "min-h-32 resize-y leading-6")}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Alex: Let’s start with the onboarding feedback…"
            />
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-muted/50 p-3 text-xs leading-5 text-muted-foreground">
            <Checkbox
              className="mt-0.5"
              checked={consent}
              onCheckedChange={setConsent}
              required
            />
            Participants were informed of transcription and sharing with this
            Forge team and OpenAI for summaries.
          </label>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t border-border/50 pt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                !consent ||
                !selectedTeam ||
                !title.trim() ||
                !text.trim()
              }
            >
              {busy ? "Importing…" : "Import call"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
