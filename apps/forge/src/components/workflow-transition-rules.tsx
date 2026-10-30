import * as React from "react"
import { useIssueDefinitions } from "./issue-definition-provider"
import { Button } from "./ui/button"
import { canTransition } from "@/lib/issue-definition-contract"

export function WorkflowTransitionRules({ teamId }: { teamId: string }) {
  const { snapshot, save } = useIssueDefinitions(teamId)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState("")
  const statuses = snapshot.value.statuses.statuses
  async function update(from: string, to: string, allowed: boolean) {
    const targets = statuses
      .filter(
        (s) =>
          s.id !== from && canTransition(snapshot.value.transitions, from, s.id)
      )
      .map((s) => s.id)
    const transitions = {
      ...snapshot.value.transitions,
      [from]: allowed
        ? [...new Set([...targets, to])]
        : targets.filter((id) => id !== to),
    }
    setSaving(true)
    setError("")
    try {
      await save({
        teamId,
        expectedRevision: snapshot.revision,
        value: { ...snapshot.value, transitions },
        statusReplacements: {},
        labelReplacements: {},
      })
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Transition rules could not be saved."
      )
    } finally {
      setSaving(false)
    }
  }
  return (
    <section className="mb-12" aria-label="Allowed status transitions">
      <h2 className="px-4 text-base font-medium">Allowed status transitions</h2>
      <p className="mt-1 mb-4 px-4 text-sm text-muted-foreground">
        Choose where issues can move from each status. Staying in the same
        status is always allowed. New statuses allow all transitions until you
        restrict them.
      </p>
      {error && (
        <p role="alert" className="mb-3 px-4 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-xl bg-muted/35 p-4 ring-1 ring-border/30">
        <table className="w-full border-collapse text-left text-xs">
          <caption className="sr-only">
            Rows are the current status. Columns are the destination status.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="p-2">
                From / to
              </th>
              {statuses.map((s) => (
                <th key={s.id} scope="col" className="max-w-28 p-2 font-medium">
                  {s.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {statuses.map((from) => (
              <tr key={from.id}>
                <th scope="row" className="p-2 font-medium">
                  {from.name}
                </th>
                {statuses.map((to) => (
                  <td key={to.id} className="p-2">
                    <input
                      type="checkbox"
                      className="size-4 accent-[#5e6ad2]"
                      aria-label={`${from.name} to ${to.name}`}
                      checked={canTransition(
                        snapshot.value.transitions,
                        from.id,
                        to.id
                      )}
                      disabled={
                        saving || !snapshot.canManage || from.id === to.id
                      }
                      onChange={(e) =>
                        void update(from.id, to.id, e.target.checked)
                      }
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button
        variant="ghost"
        className="mt-2"
        disabled={
          saving ||
          !snapshot.canManage ||
          !Object.keys(snapshot.value.transitions).length
        }
        onClick={async () => {
          setSaving(true)
          setError("")
          try {
            await save({
              teamId,
              expectedRevision: snapshot.revision,
              value: { ...snapshot.value, transitions: {} },
              statusReplacements: {},
              labelReplacements: {},
            })
          } catch (e) {
            setError(
              e instanceof Error
                ? e.message
                : "Transition rules could not be saved."
            )
          } finally {
            setSaving(false)
          }
        }}
      >
        Allow all transitions
      </Button>
    </section>
  )
}
