import { useEffect, useRef, useState } from "react"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamIssue } from "@/lib/issue-record-contract"
import type { TemplateDirectory } from "@/lib/template-contract"
import { loadTemplates } from "@/lib/template-state"
import { getIssueStatuses } from "@/lib/team-issues"
import { enqueueIssueEdits } from "@/lib/canonical-issue-edit-client"
import { Button } from "@/components/ui/button"
import { OptionSelect } from "@/components/ui/option-select"

export function TriageDecisionControls({
  team,
  issue,
}: {
  team: TeamSummary
  issue: TeamIssue
}) {
  // Hold the version the triager reviewed even when background queries refresh.
  const baseline = useRef(issue)
  const statuses = getIssueStatuses(team.id)
  const accepted = statuses.filter((status) =>
    ["backlog", "unstarted", "started"].includes(status.group)
  )
  const canceled = statuses.filter((status) => status.group === "canceled")
  const [status, setStatus] = useState(
    () =>
      accepted.find((s) => s.id === issue.status)?.id ?? accepted[0]?.id ?? ""
  )
  const [declinedStatus, setDeclinedStatus] = useState(
    () => canceled[0]?.id ?? ""
  )
  const [assignee, setAssignee] = useState(issue.assignee ?? "")
  const [directory, setDirectory] = useState<TemplateDirectory>()
  const [error, setError] = useState("")
  const submitted = useRef(false)
  useEffect(() => {
    let active = true
    loadTemplates({ data: { slug: team.slug } })
      .then((result) => {
        if (active) setDirectory(result)
      })
      .catch(() => {
        if (active)
          setError(
            "Team members could not be loaded. Reopen this issue to retry."
          )
      })
    return () => {
      active = false
    }
  }, [team.slug])
  function decide(decision: "accept" | "decline") {
    if (submitted.current) return
    try {
      submitted.current = true
      enqueueIssueEdits(team.id, [
        {
          before: baseline.current,
          triageDecision: decision,
          changes:
            decision === "accept"
              ? { status, assignee }
              : { status: declinedStatus },
        },
      ])
    } catch (failure) {
      submitted.current = false
      setError(
        failure instanceof Error
          ? failure.message
          : "The triage decision could not be saved."
      )
    }
  }
  return (
    <div className="mt-8 space-y-3" aria-label="Triage decision">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs">
          Accept into
          <OptionSelect
            aria-label="Acceptance status"
            value={status}
            onValueChange={setStatus}
          >
            {accepted.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </OptionSelect>
        </label>
        <label className="flex flex-col gap-1 text-xs">
          Assignee
          <OptionSelect
            aria-label="Triage assignee"
            value={assignee}
            onValueChange={setAssignee}
            disabled={!directory}
          >
            <option value="">Unassigned</option>
            {directory?.members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </OptionSelect>
        </label>
        <Button
          size="sm"
          disabled={
            !directory ||
            !accepted.some((s) => s.id === status) ||
            Boolean(
              assignee && !directory.members.some((m) => m.id === assignee)
            )
          }
          onClick={() => decide("accept")}
        >
          Accept issue
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {canceled.length > 1 && (
          <label className="flex flex-col gap-1 text-xs">
            Decline into
            <OptionSelect
              aria-label="Decline status"
              value={declinedStatus}
              onValueChange={setDeclinedStatus}
            >
              {canceled.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </OptionSelect>
          </label>
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={!canceled.some((s) => s.id === declinedStatus)}
          onClick={() => decide("decline")}
        >
          Decline issue
        </Button>
        <p className="text-xs text-muted-foreground">
          Declining moves this issue to{" "}
          {canceled.find((s) => s.id === declinedStatus)?.name ??
            "a Canceled status"}
          .
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
