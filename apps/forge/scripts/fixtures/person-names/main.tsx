import { useState } from "react"
import { createRoot } from "react-dom/client"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import { people } from "./data"
import type { TeamIssue } from "@/lib/team-issues"
import {
  AccountPreferenceScope,
  usePreferenceGroup,
} from "@/components/account-preference-provider"
import { PersonNameScope } from "@/components/person-name-provider"
import { AccountPreferenceClient } from "@/lib/account-preference-client"
import {
  emptyPreferenceSnapshot,
  preferenceSnapshotSchema,
} from "@/lib/account-preference-contract"
import { ActivityAuthor } from "@/components/initiatives/activity-author"
import {
  InlineIssueProperties,
  IssueRows,
} from "@/components/issues/issue-list"
import { SharedCommentInput } from "@/components/issues/shared-comment-input"
import { SafeCommentContent } from "@/components/issues/safe-comment-content"
import { WorkspaceMembers } from "@/components/workspace-members"
import { blankIssueDraft, defaultIssueDisplay } from "@/lib/team-issues"
import { initialTeamStatuses } from "@/lib/team-statuses"
import { replaceCanonicalIssues } from "@/lib/canonical-issue-cache"
import "./fixture.css"

let snapshot = emptyPreferenceSnapshot("viewer")
const client = new AccountPreferenceClient(
  { userId: "viewer", sessionId: "fixture", workspaceId: "fixture" },
  {
    load: async () => ({ status: "ready", snapshot }),
    save: async (command) => {
      const revision = snapshot.revision + 1
      snapshot = preferenceSnapshotSchema.parse({
        ...snapshot,
        revision,
        values: { ...snapshot.values, ...command.patch },
        fieldVersions: {
          ...snapshot.fieldVersions,
          ...Object.fromEntries(
            Object.keys(command.patch).map((key) => [key, revision])
          ),
        },
      })
      return { status: "saved", snapshot }
    },
  }
)
await client.refresh()
replaceCanonicalIssues({
  workspaceId: "fixture",
  userId: "viewer",
  sessionId: "fixture",
  records: [],
  projects: [],
  cycles: [],
})
const statuses = initialTeamStatuses().statuses
const original: TeamIssue = {
  ...blankIssueDraft(),
  id: "f58de071-9917-4c67-8f88-278282788159",
  number: 130,
  title: "Recognize the right Alex",
  status: statuses[0].id,
  assignee: people[1].id,
  creator: people[0].id,
  activity: [],
  createdAt: "2026-11-03T12:00:00Z",
  updatedAt: "2026-11-03T12:00:00Z",
  statusChangedAt: "2026-11-03T12:00:00Z",
  completedAt: null,
  suggestedLabel: "",
  recurrenceSpawned: false,
}
const document = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "mention",
          attrs: { id: people[1].id, label: "Original Alex snapshot" },
        },
        { type: "text", text: " can take this issue." },
      ],
    },
  ],
}
const access = {
  canManage: false,
  currentUserId: "viewer",
  invitations: [],
  members: people.map((person) => ({
    ...person,
    userId: person.id,
    email: `${person.id}@example.test`,
    title: null,
    role: "member",
    joinedAt: "2026-11-03T12:00:00Z",
    lastSeenAt: null,
    teamCount: 0,
    isOnline: false,
  })),
}
function Demo() {
  const { preferences, update } = usePreferenceGroup("general")
  const [issue, setIssue] = useState(original)
  const [target, setTarget] = useState("")
  return (
    <main className="mx-auto max-w-6xl space-y-6 p-8 text-sm">
      <header className="flex items-center justify-between">
        <div>
          <p className="text-xs text-muted-foreground">
            FOR-130 · Local fixture · No backend access
          </p>
          <h1 className="mt-1 text-xl font-medium">
            One name preference, every person
          </h1>
        </div>
        <div className="flex gap-2">
          {(["username", "full-name"] as const).map((format) => (
            <button
              key={format}
              aria-pressed={preferences.displayNames === format}
              className="rounded-lg border px-3 py-2 aria-pressed:bg-muted"
              onClick={() => update({ ...preferences, displayNames: format })}
            >
              {format === "username" ? "Username" : "Full name"}
            </button>
          ))}
        </div>
      </header>
      <div className="grid grid-cols-2 gap-5">
        <section className="space-y-4 rounded-xl border p-5">
          <h2 className="font-medium">Assignee, activity and stored mention</h2>
          <InlineIssueProperties
            issue={issue}
            statuses={statuses}
            members={people}
            property="assignee"
            onUpdate={(_, patch) => setIssue({ ...issue, ...patch })}
          />
          <ActivityAuthor person={people[0]} userId="viewer" />
          <SafeCommentContent document={document} fallback="" />
          <p className="text-xs text-muted-foreground">
            Immutable assignee: <output>{issue.assignee}</output>
          </p>
          <SharedCommentInput
            teamId="6ac18b75-07f7-41dc-9890-a52cccd4c551"
            issueId={issue.id}
          />
        </section>
        <section className="rounded-xl border p-5">
          <h2 className="mb-3 font-medium">Duplicate assignee groups</h2>
          <IssueRows
            issues={[]}
            allIssues={[]}
            identifier="FOR"
            team={{ slug: "forge", name: "Forge" }}
            statuses={statuses}
            members={people}
            display={{
              ...defaultIssueDisplay(),
              group: "Assignee",
              showEmpty: true,
            }}
            selected={[]}
            onSelect={() => {}}
            onOpen={() => {}}
            onUpdate={() => {}}
            onCreate={(patch) => setTarget(patch?.assignee ?? "")}
          />
          <p className="mt-4 text-xs text-muted-foreground">
            Create target: <output>{target || "Choose a group"}</output>
          </p>
        </section>
      </div>
      <section className="rounded-xl border">
        <WorkspaceMembers access={access} teams={[]} />
      </section>
    </main>
  )
}
const route = createRootRoute({
  component: () => (
    <AccountPreferenceScope client={client}>
      <PersonNameScope value={{ enabled: true, people }}>
        <Demo />
      </PersonNameScope>
    </AccountPreferenceScope>
  ),
})
const router = createRouter({
  routeTree: route,
  history: createMemoryHistory({ initialEntries: ["/"] }),
})
createRoot(window.document.getElementById("root")!).render(
  <RouterProvider router={router} />
)
