import { createFileRoute } from "@tanstack/react-router"
import { TeamIssueLabelsSettings } from "@/components/team-issue-labels-settings"

export const Route = createFileRoute("/settings/project-labels")({
  component: ProjectLabelsPage,
})

function ProjectLabelsPage() {
  return <TeamIssueLabelsSettings key="project-labels" entity="project" />
}
