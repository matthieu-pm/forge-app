import * as React from "react"
import type { TeamSummary } from "@/lib/team-contract"
import type { DefinitionValue } from "@/lib/issue-definition-contract"
import type { TeamStatus } from "@/lib/team-statuses"
import type { TeamLabel, TeamLabelGroup } from "@/lib/team-labels"
import { definitionValueSchema } from "@/lib/issue-definition-contract"
import { statusGroups } from "@/lib/team-statuses"
import { useIssueDefinitions } from "@/components/issue-definition-provider"
import { IssueStatusIcon } from "@/components/issue-status-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { readIssueStore } from "@/lib/team-issues"

const selectClass =
  "h-8 rounded-lg border border-border bg-muted/40 px-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
const cardClass = "rounded-xl bg-muted/35 p-4 ring-1 ring-border/30"
function useEditor(teamId: string | null) {
  const { snapshot, save } = useIssueDefinitions(teamId)
  const [error, setError] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  async function commit(
    value: DefinitionValue,
    statusReplacements: Record<string, string> = {},
    labelReplacements: Record<string, string> = {}
  ) {
    if (saving || !snapshot.canManage) return false
    setError("")
    setSaving(true)
    try {
      await save({
        teamId,
        expectedRevision: snapshot.revision,
        value: (() => {
          const parsed = definitionValueSchema.safeParse(value)
          if (!parsed.success) throw new Error(parsed.error.issues[0].message)
          return parsed.data
        })(),
        statusReplacements,
        labelReplacements,
      })
      return true
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Changes could not be saved. Try again."
      )
      return false
    } finally {
      setSaving(false)
    }
  }
  return {
    snapshot,
    value: snapshot.value,
    commit,
    error,
    saving,
    disabled: saving || !snapshot.canManage,
    setError,
  }
}
function Frame({
  title,
  description,
  error,
  readOnly,
  children,
}: {
  title: string
  description: string
  error: string
  readOnly: boolean
  children: React.ReactNode
}) {
  return (
    <main className="forge-settings-scroll">
      <div className="forge-settings-content">
        <header className="forge-page-header forge-settings-header">
          <h1>{title}</h1>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
            {description}
          </p>
        </header>
        {readOnly && (
          <p className="mb-4 text-sm text-muted-foreground">
            Only workspace owners and admins can change these definitions.
          </p>
        )}
        {error && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {children}
      </div>
    </main>
  )
}
function migrateStatus(value: DefinitionValue, source: string, target: string) {
  const next = structuredClone(value)
  next.statuses.statuses = next.statuses.statuses.filter((s) => s.id !== source)
  if (target && next.statuses.defaultId === source)
    next.statuses.defaultId = target
  for (const rules of [
    next.workflows.pullRequests,
    ...next.workflows.branches.map((b) => b.rules),
  ])
    for (const key of Object.keys(rules) as Array<keyof typeof rules>)
      if (target && rules[key] === source) rules[key] = target
  if (target && next.workflows.staleStatus === source)
    next.workflows.staleStatus = target
  const transitions: DefinitionValue["transitions"] = {}
  for (const [from, to] of Object.entries(next.transitions)) {
    if (from === source) continue
    transitions[from] = [
      ...new Set(to.map((id) => (id === source ? target : id)).filter(Boolean)),
    ]
  }
  next.transitions = transitions
  return next
}
export function SharedIssueStatusesSettings({ team }: { team: TeamSummary }) {
  const { snapshot, value, commit, error, disabled, saving, setError } =
    useEditor(team.id)
  const [editor, setEditor] = React.useState<TeamStatus | null>(null)
  const [remove, setRemove] = React.useState<TeamStatus | null>(null)
  const [replacement, setReplacement] = React.useState("")
  const [notice, setNotice] = React.useState("")
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!editor) return
    const exists = value.statuses.statuses.some((s) => s.id === editor.id)
    const statuses = exists
      ? value.statuses.statuses.map((s) => (s.id === editor.id ? editor : s))
      : [...value.statuses.statuses, editor]
    if (await commit({ ...value, statuses: { ...value.statuses, statuses } })) {
      setEditor(null)
      setNotice("Status saved.")
    }
  }
  return (
    <Frame
      title="Issue statuses"
      description="Shared statuses define the workflow for everyone in this team."
      error={error}
      readOnly={!snapshot.canManage}
    >
      <div role="status" className="mb-3 text-sm text-muted-foreground">
        {saving ? "Saving…" : notice}
      </div>
      <div className={cardClass}>
        {statusGroups.map((group) => (
          <section
            key={group.id}
            className="mb-4 last:mb-0"
            aria-label={group.name}
          >
            <div className="mb-1 flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted-foreground">
                {group.name}
              </h2>
              {group.id !== "duplicate" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    setEditor({
                      id: crypto.randomUUID(),
                      group: group.id,
                      name: "",
                      description: "",
                      color: group.color,
                    })
                    setError("")
                  }}
                >
                  Add {group.name.toLowerCase()} status
                </Button>
              )}
            </div>
            {value.statuses.statuses
              .filter((s) => s.group === group.id)
              .map((status, index, list) => (
                <div
                  key={status.id}
                  className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border/40 py-2 last:border-0"
                >
                  <IssueStatusIcon group={status.group} color={status.color} />
                  <span className="min-w-24 flex-1 text-sm">
                    {status.name}
                    {value.statuses.defaultId === status.id && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        Default
                      </span>
                    )}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || index === 0}
                    aria-label={`Move ${status.name} up`}
                    onClick={() => {
                      const statuses = [...value.statuses.statuses]
                      const a = statuses.findIndex((s) => s.id === status.id),
                        b = statuses.findIndex(
                          (s) => s.id === list[index - 1].id
                        )
                      ;[statuses[a], statuses[b]] = [statuses[b], statuses[a]]
                      void commit({
                        ...value,
                        statuses: { ...value.statuses, statuses },
                      })
                    }}
                  >
                    ↑
                  </Button>
                  {status.group !== "duplicate" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={
                        disabled || value.statuses.defaultId === status.id
                      }
                      onClick={() =>
                        void commit({
                          ...value,
                          statuses: { ...value.statuses, defaultId: status.id },
                        })
                      }
                    >
                      Set default
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={`Edit ${status.name}`}
                    onClick={() => setEditor({ ...status })}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={disabled || list.length === 1}
                    aria-label={`Delete ${status.name}`}
                    onClick={() => {
                      setRemove(status)
                      setReplacement("")
                    }}
                  >
                    Delete
                  </Button>
                </div>
              ))}
          </section>
        ))}
      </div>
      {editor && (
        <form
          aria-label="Edit status"
          onSubmit={submit}
          className={`${cardClass} mt-4 space-y-3`}
        >
          <label className="block text-sm">
            Name
            <Input
              autoFocus
              aria-label="Status name"
              maxLength={80}
              value={editor.name}
              onChange={(e) => setEditor({ ...editor, name: e.target.value })}
            />
          </label>
          <label className="block text-sm">
            Description
            <Input
              aria-label="Status description"
              maxLength={240}
              value={editor.description}
              onChange={(e) =>
                setEditor({ ...editor, description: e.target.value })
              }
            />
          </label>
          <label className="flex items-center gap-3 text-sm">
            Color
            <input
              aria-label="Status color"
              type="color"
              value={editor.color}
              onChange={(e) => setEditor({ ...editor, color: e.target.value })}
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={disabled || !editor.name.trim()}>
              Save status
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => setEditor(null)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {remove && (
        <div
          role="dialog"
          aria-label={`Delete ${remove.name}`}
          className={`${cardClass} mt-4 space-y-3`}
        >
          <p className="text-sm">
            Delete {remove.name}? Assigned issues require a replacement. A
            replacement also updates the default status and automation
            references.
          </p>
          <label className="block text-sm">
            Replacement
            <select
              aria-label="Replacement status"
              className={`${selectClass} ml-3`}
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
            >
              <option value="">No replacement</option>
              {value.statuses.statuses
                .filter((s) => s.id !== remove.id && s.group !== "duplicate")
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          <Button
            disabled={disabled}
            onClick={async () => {
              // Local issues are preserved drafts; never rewrite or publish them during a definition migration.
              try {
                if (
                  readIssueStore(team.id).issues.some(
                    (i) => i.status === remove.id
                  )
                ) {
                  setError(
                    "This status is used by local issues. Move them to another status before deleting it."
                  )
                  return
                }
              } catch {
                setError("Local issues could not be checked. Try again.")
                return
              }
              const next = migrateStatus(value, remove.id, replacement)
              if (
                await commit(
                  next,
                  replacement ? { [remove.id]: replacement } : {}
                )
              ) {
                setRemove(null)
                setNotice("Status deleted.")
              }
            }}
          >
            Delete status
          </Button>
          <Button
            variant="ghost"
            disabled={saving}
            onClick={() => setRemove(null)}
          >
            Cancel
          </Button>
        </div>
      )}
    </Frame>
  )
}

export function SharedIssueLabelsSettings({ team }: { team?: TeamSummary }) {
  const [workspaceView, setWorkspaceView] = React.useState(!team)
  const teamId = workspaceView ? null : team!.id
  const { snapshot, value, commit, error, disabled, saving, setError } =
    useEditor(teamId)
  const { snapshot: workspace } = useIssueDefinitions(null)
  const [query, setQuery] = React.useState("")
  const [editor, setEditor] = React.useState<{
    kind: "label" | "group"
    item: TeamLabel | TeamLabelGroup
  } | null>(null)
  const [remove, setRemove] = React.useState<TeamLabel | null>(null)
  const [replacement, setReplacement] = React.useState("")
  function start(kind: "label" | "group") {
    setEditor({
      kind,
      item: {
        id: crypto.randomUUID(),
        name: "",
        description: "",
        color: "#5e6ad2",
        createdAt: new Date().toISOString(),
        ...(kind === "label"
          ? { groupId: null, issues: 0, lastApplied: null }
          : {}),
      },
    })
  }
  const filtered = value.labels.labels.filter((l) =>
    l.name.toLowerCase().includes(query.toLowerCase())
  )
  return (
    <Frame
      title="Issue labels"
      description="Labels are shared with everyone who can access their team or workspace."
      error={error}
      readOnly={!snapshot.canManage}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {team && (
          <select
            aria-label="Label scope"
            className={selectClass}
            value={workspaceView ? "workspace" : "team"}
            onChange={(e) => {
              setWorkspaceView(e.target.value === "workspace")
              setEditor(null)
              setRemove(null)
              setError("")
            }}
          >
            <option value="team">{team.name} labels</option>
            <option value="workspace">Workspace labels</option>
          </select>
        )}
        <Input
          className="max-w-64"
          aria-label="Search labels"
          placeholder="Search labels…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button disabled={disabled} onClick={() => start("label")}>
          New label
        </Button>
        <Button
          variant="secondary"
          disabled={disabled}
          onClick={() => start("group")}
        >
          New group
        </Button>
      </div>
      <div className={cardClass}>
        {!filtered.length && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {query
              ? "No matching labels."
              : "No labels yet. Create a label to organize issues."}
          </p>
        )}
        {filtered.map((label) => (
          <div
            key={label.id}
            className="flex min-h-12 flex-wrap items-center gap-3 border-b border-border/40 py-2 last:border-0"
          >
            <span
              className="size-2 rounded-full"
              style={{ background: label.color }}
            />
            <span className="min-w-24 flex-1 text-sm">
              {label.name}
              <span className="ml-2 text-xs text-muted-foreground">
                {value.labels.groups.find((g) => g.id === label.groupId)?.name}
                {label.archived ? " · Archived" : ""}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              {label.issues} issues
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              aria-label={`Edit ${label.name}`}
              onClick={() => setEditor({ kind: "label", item: { ...label } })}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                void commit({
                  ...value,
                  labels: {
                    ...value.labels,
                    labels: value.labels.labels.map((l) =>
                      l.id === label.id ? { ...l, archived: !l.archived } : l
                    ),
                  },
                })
              }
            >
              {label.archived ? "Restore" : "Archive"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              aria-label={`Delete ${label.name}`}
              onClick={() => {
                setRemove(label)
                setReplacement("")
              }}
            >
              Delete
            </Button>
          </div>
        ))}
      </div>
      {!!value.labels.groups.length && (
        <section className={`${cardClass} mt-4`} aria-label="Label groups">
          <h2 className="mb-2 text-sm font-medium">Groups</h2>
          {value.labels.groups.map((group) => (
            <div
              key={group.id}
              className="flex items-center gap-3 py-2 text-sm"
            >
              <span className="flex-1">{group.name}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={disabled}
                onClick={() => setEditor({ kind: "group", item: { ...group } })}
              >
                Edit group
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={
                  disabled ||
                  value.labels.labels.some((l) => l.groupId === group.id)
                }
                onClick={() =>
                  void commit({
                    ...value,
                    labels: {
                      ...value.labels,
                      groups: value.labels.groups.filter(
                        (g) => g.id !== group.id
                      ),
                    },
                  })
                }
              >
                Delete group
              </Button>
            </div>
          ))}
          <p className="mt-2 text-xs text-muted-foreground">
            Move labels out of a group before deleting it.
          </p>
        </section>
      )}
      {team && !workspaceView && (
        <section
          className={`${cardClass} mt-4`}
          aria-label="Inherited workspace labels"
        >
          <h2 className="mb-2 text-sm font-medium">
            Workspace labels · inherited
          </h2>
          <p className="text-sm text-muted-foreground">
            {workspace.value.labels.labels
              .filter((l) => !l.archived)
              .map((l) => l.name)
              .join(", ") || "No workspace labels."}
          </p>
        </section>
      )}
      {editor && (
        <form
          aria-label={`Edit ${editor.kind}`}
          className={`${cardClass} mt-4 space-y-3`}
          onSubmit={async (e) => {
            e.preventDefault()
            const key = editor.kind === "label" ? "labels" : "groups"
            const labels = {
              ...value.labels,
              [key]: [
                ...value.labels[key].filter((l) => l.id !== editor.item.id),
                editor.item,
              ],
            }
            if (
              await commit({ ...value, labels: labels as typeof value.labels })
            )
              setEditor(null)
          }}
        >
          <label className="block text-sm">
            Name
            <Input
              autoFocus
              aria-label="Definition name"
              maxLength={80}
              value={editor.item.name}
              onChange={(e) =>
                setEditor({
                  ...editor,
                  item: { ...editor.item, name: e.target.value },
                })
              }
            />
          </label>
          <label className="block text-sm">
            Description
            <Input
              aria-label="Definition description"
              maxLength={500}
              value={editor.item.description}
              onChange={(e) =>
                setEditor({
                  ...editor,
                  item: { ...editor.item, description: e.target.value },
                })
              }
            />
          </label>
          <label className="flex items-center gap-3 text-sm">
            Color
            <input
              type="color"
              aria-label="Definition color"
              value={editor.item.color}
              onChange={(e) =>
                setEditor({
                  ...editor,
                  item: { ...editor.item, color: e.target.value },
                })
              }
            />
          </label>
          {editor.kind === "label" && (
            <label className="block text-sm">
              Group
              <select
                aria-label="Label group"
                className={`${selectClass} ml-3`}
                value={(editor.item as TeamLabel).groupId ?? ""}
                onChange={(e) =>
                  setEditor({
                    ...editor,
                    item: {
                      ...editor.item,
                      groupId: e.target.value || null,
                    } as TeamLabel,
                  })
                }
              >
                <option value="">No group</option>
                {value.labels.groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Button type="submit" disabled={disabled || !editor.item.name.trim()}>
            Save {editor.kind}
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={() => setEditor(null)}
          >
            Cancel
          </Button>
        </form>
      )}
      {remove && (
        <div
          role="dialog"
          aria-label={`Delete ${remove.name}`}
          className={`${cardClass} mt-4 space-y-3`}
        >
          <p className="text-sm">
            Assigned labels require a replacement. Archive a label to retain its
            existing assignments.
          </p>
          <select
            aria-label="Replacement label"
            className={selectClass}
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          >
            <option value="">No replacement</option>
            {value.labels.labels
              .filter((l) => l.id !== remove.id && !l.archived)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
          <div>
            <Button
              disabled={disabled}
              onClick={async () => {
                if (teamId) {
                  try {
                    if (
                      readIssueStore(teamId).issues.some((i) =>
                        (i.labels ?? "")
                          .split(",")
                          .map((l) => l.trim())
                          .includes(remove.name)
                      )
                    ) {
                      setError(
                        "This label is used by local issues. Remove it from those issues or archive it instead."
                      )
                      return
                    }
                  } catch {
                    setError("Local issues could not be checked. Try again.")
                    return
                  }
                }
                if (
                  await commit(
                    {
                      ...value,
                      labels: {
                        ...value.labels,
                        labels: value.labels.labels.filter(
                          (l) => l.id !== remove.id
                        ),
                      },
                    },
                    {},
                    replacement ? { [remove.id]: replacement } : {}
                  )
                )
                  setRemove(null)
              }}
            >
              Delete label
            </Button>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => setRemove(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Frame>
  )
}
