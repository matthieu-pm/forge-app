import * as React from "react"
import { RecurringIssues } from "./recurring-issues"
import { RecurringIssueEditor } from "./recurring-issue-editor"
import type { TeamSummary } from "@/lib/team-contract"
import type { TemplateDirectory } from "@/lib/template-contract"
import type { SavedRecurringIssue } from "@/lib/recurring-issue-contract"
import { loadRecurringIssues } from "@/lib/recurring-issue-state"
import { loadTemplates } from "@/lib/template-state"
import { protectedSessionEpoch } from "@/lib/protected-session"
import { Button } from "@/components/ui/button"

export function RecurringIssueSettings({
  team,
  recurringId,
}: {
  team: TeamSummary
  recurringId?: string
}) {
  const [data, setData] = React.useState<{
    directory: TemplateDirectory
    issues: Array<SavedRecurringIssue>
  } | null>(null)
  const [error, setError] = React.useState("")
  const [attempt, setAttempt] = React.useState(0)
  React.useEffect(() => {
    let active = true
    const epoch = protectedSessionEpoch()
    setData(null)
    setError("")
    void Promise.all([
      loadTemplates({ data: { slug: team.slug } }),
      loadRecurringIssues({ data: { slug: team.slug } }),
    ])
      .then(([directory, issues]) => {
        if (active && epoch === protectedSessionEpoch())
          setData({ directory, issues })
      })
      .catch(() => {
        if (active && epoch === protectedSessionEpoch())
          setError("Recurring issues could not be loaded. Try again.")
      })
    return () => {
      active = false
    }
  }, [team.id, team.slug, recurringId, attempt])
  if (error)
    return (
      <div className="p-8">
        <p role="alert">{error}</p>
        <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
          Try again
        </Button>
      </div>
    )
  if (!data)
    return (
      <p role="status" className="p-8 text-sm text-muted-foreground">
        Loading recurring issues…
      </p>
    )
  const saved = data.issues.find((item) => item.id === recurringId)
  if (recurringId && recurringId !== "new" && !saved)
    return (
      <p role="alert" className="p-8">
        This recurring issue is no longer available.
      </p>
    )
  return recurringId ? (
    <RecurringIssueEditor
      key={`${team.id}:${recurringId}`}
      team={team}
      directory={data.directory}
      saved={saved}
    />
  ) : (
    <RecurringIssues
      team={team}
      issues={data.issues}
      canManage={data.directory.canManage}
    />
  )
}
