import { createFileRoute } from "@tanstack/react-router"
import { TeamIssueLabelsSettings } from "@/components/team-issue-labels-settings"

export const Route = createFileRoute("/settings/initiative-labels")({
  component: () => (
    <TeamIssueLabelsSettings key="initiative-labels" entity="initiative" />
  ),
})
