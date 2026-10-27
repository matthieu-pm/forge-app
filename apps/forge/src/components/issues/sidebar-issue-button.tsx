import { useState } from "react"
import { PencilEdit02Icon } from "@hugeicons/core-free-icons"
import { useRouter } from "@tanstack/react-router"
import { toast } from "sonner"
import { IssueComposer } from "./issue-composer"
import type { TeamSummary } from "@/lib/team-contract"
import type { TemplateDirectory } from "@/lib/template-contract"
import type { IssueDraft } from "@/lib/team-issues"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { loadTemplates } from "@/lib/template-state"
import {
  blankIssueDraft,
  getIssueStatuses,
  readIssueStore,
} from "@/lib/team-issues"
import {
  initialTeamLabels,
  parseTeamLabels,
  teamLabelsStorageKey,
} from "@/lib/team-labels"

export function SidebarIssueButton({ pathname }: { pathname: string }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [editor, setEditor] = useState<{
    team: TeamSummary
    directory: TemplateDirectory
    draft: IssueDraft
    labels: Array<string>
    projects: Array<string>
  }>()

  async function openComposer() {
    setLoading(true)
    try {
      const directory = await loadTemplates({ data: {} })
      const slug = pathname.match(/^\/teams\/([^/]+)/)?.[1]
      const team =
        directory.teams.find((item) => item.slug === slug) ??
        directory.teams.at(0)
      if (!team) {
        toast.info("Join a team to create an issue", {
          action: {
            label: "Find a team",
            onClick: () => void router.navigate({ to: "/workspace/teams" }),
          },
        })
        return
      }
      const statuses = getIssueStatuses(team.id)
      const store = readIssueStore(team.id)
      const rawLabels = localStorage.getItem(teamLabelsStorageKey(team.id))
      const labels = (
        rawLabels ? parseTeamLabels(rawLabels) : initialTeamLabels(team.slug)
      ).labels
      setEditor({
        team,
        directory,
        draft: blankIssueDraft(
          statuses.find((status) => status.group === "unstarted")?.id ??
            statuses.at(0)?.id
        ),
        labels: labels
          .filter((label) => !label.archived)
          .map((label) => label.name),
        projects: [
          ...new Set(
            store.issues.map((issue) => issue.project ?? "").filter(Boolean)
          ),
        ],
      })
    } catch {
      toast.error("The issue composer could not be opened. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <ActionIconButton
        label="Create new issue"
        icon={PencilEdit02Icon}
        disabled={loading}
        aria-busy={loading}
        className="group-data-[collapsible=icon]:hidden"
        onClick={() => void openComposer()}
      />
      {editor && (
        <IssueComposer
          team={editor.team}
          directory={editor.directory}
          initial={editor.draft}
          labels={editor.labels}
          projects={editor.projects}
          onClose={() => setEditor(undefined)}
          onDraftSaved={() => toast.success("Draft saved")}
          onSaved={(issue, team) =>
            toast.success("Issue created", {
              action: {
                label: "Open issue",
                onClick: () =>
                  void router.navigate({
                    to: "/teams/$teamSlug/issues",
                    params: { teamSlug: team.slug },
                    search: { view: "all", issue: issue.id },
                  }),
              },
            })
          }
        />
      )}
    </>
  )
}
