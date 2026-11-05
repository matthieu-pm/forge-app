import * as React from "react"
import { createRoot } from "react-dom/client"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { loadProductState } from "./storage-stub"
import type { TeamSummary } from "@/lib/team-contract"
import type { SavedRecurringIssue } from "@/lib/recurring-issue-contract"
import { emptyRecurringIssue } from "@/lib/recurring-issue-contract"
import { RecurringIssueEditor } from "@/components/recurring-issues/recurring-issue-editor"
import { RecurringIssues } from "@/components/recurring-issues/recurring-issues"
import { initializeProductStorage } from "@/lib/product-storage"
import "./fixture.css"

const team = {
  id: "00000000-0000-4000-8000-000000000068",
  slug: "planning",
  name: "Planning",
  identifier: "PLAN",
  timezone: "Europe/Paris",
} as TeamSummary
const directory = {
  teams: [team],
  members: [],
  templates: [],
  defaults: { members: null, nonMembers: null },
  canManage: true,
}
initializeProductStorage(await loadProductState())
function Fixture() {
  const [saved, setSaved] = React.useState<SavedRecurringIssue | null>(null)
  const [editing, setEditing] = React.useState(true)
  React.useEffect(() => {
    const accept = (event: Event) => {
      setSaved((event as CustomEvent<SavedRecurringIssue>).detail)
      setEditing(false)
    }
    window.addEventListener("for68-fixture-saved", accept)
    return () => window.removeEventListener("for68-fixture-saved", accept)
  }, [])
  return (
    <div className="dark flex h-screen flex-col bg-background text-foreground">
      <div className="border-b border-border px-6 py-3 text-xs text-muted-foreground">
        FOR-68 · Local UI fixture · Synthetic saves. Canonical generation is
        verified separately on PostgreSQL.
      </div>
      <button
        className="mx-6 my-2 self-start text-xs underline"
        onClick={() => {
          setSaved({
            id: "00000000-0000-4000-8000-000000000069",
            payload: {
              ...emptyRecurringIssue(team.id, team.timezone),
              title: "Daily operations · downtime example",
              firstDue: "2026-10-29",
              unit: "day",
            },
            createdAt: "2026-10-29T08:00:00Z",
            updatedAt: "2026-11-05T08:00:00Z",
            state: "active",
            ownerId: "fixture-owner",
            skippedCount: 6,
            lastReason: "downtime-latest-only",
            recentEvents: [
              {
                reason: "downtime-latest-only",
                fromDate: "2026-10-30",
                toDate: "2026-11-04",
                count: 6,
              },
            ],
          })
          setEditing(true)
        }}
      >
        Load downtime example
      </button>
      <div className="min-h-0 flex-1">
        {editing ? (
          <RecurringIssueEditor
            key={saved?.id ?? "new"}
            team={team}
            directory={directory}
            saved={saved ?? undefined}
          />
        ) : (
          <>
            <button
              className="m-4 rounded border px-3 py-1 text-sm"
              onClick={() => setEditing(true)}
            >
              Review saved schedule
            </button>
            <RecurringIssues
              onDeleted={(id) =>
                setSaved((current) => (current?.id === id ? null : current))
              }
              team={team}
              canManage
              issues={saved ? [saved] : []}
            />
          </>
        )}
      </div>
    </div>
  )
}
const root = createRootRoute({ component: Fixture })
const route = createRoute({
  getParentRoute: () => root,
  path: "$",
  component: () => null,
})
const router = createRouter({
  routeTree: root.addChildren([route]),
  history: createMemoryHistory({ initialEntries: ["/"] }),
})
createRoot(document.getElementById("root")!).render(
  <RouterProvider router={router} />
)
