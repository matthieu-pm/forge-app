import { createFileRoute } from "@tanstack/react-router"
import { TeamIssueLabelsSettings } from "@/components/team-issue-labels-settings"

export const Route = createFileRoute("/settings/issue-labels")({
  component: IssueLabelsPage,
})

function IssueLabelsPage() {
  return <TeamIssueLabelsSettings />
}
