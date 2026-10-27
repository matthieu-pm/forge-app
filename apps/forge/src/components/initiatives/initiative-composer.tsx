import { useState } from "react"
import {
  InitiativePropertyPicker,
  initiativePrimary,
} from "./initiative-properties"
import type {
  Initiative,
  InitiativePerson,
  InitiativeView,
} from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamLabel } from "@/lib/team-labels"
import { TeamIconPicker } from "@/components/team-icon-picker"
import { Button } from "@/components/ui/button"
import { blankInitiative } from "@/lib/initiatives"

export function InitiativeComposer({
  view,
  creatorId,
  people,
  teams,
  labels,
  onCreate,
  onCancel,
}: {
  view: InitiativeView
  creatorId: string
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  labels: Array<TeamLabel>
  onCreate: (draft: Omit<Initiative, "number">) => boolean
  onCancel: () => void
}) {
  const [draft, setDraft] = useState(() => blankInitiative(creatorId, view))
  const [error, setError] = useState("")
  return (
    <form
      aria-label="Create initiative"
      className="mx-3 mt-3 rounded-lg border border-border/30 bg-muted/40 p-4"
      onKeyDown={(event) => {
        if (
          event.key === "Escape" &&
          !event.defaultPrevented &&
          !(
            event.target instanceof Element &&
            event.target.closest(
              '[data-slot="popover-content"],[role="listbox"]'
            )
          )
        ) {
          event.preventDefault()
          onCancel()
        }
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault()
          event.currentTarget.requestSubmit()
        }
      }}
      onSubmit={(event) => {
        event.preventDefault()
        if (!draft.name.trim()) return
        if (onCreate(draft)) onCancel()
        else
          setError(
            "The initiative could not be saved. Your draft has been kept. Try again."
          )
      }}
    >
      <div className="flex items-start gap-3">
        <TeamIconPicker
          label="Choose initiative icon"
          name={draft.name || "Initiative"}
          value={draft.icon}
          onChange={(icon) => setDraft({ ...draft, icon })}
          className="size-7 rounded-full border-0 bg-red-500/10"
        />
        <div className="min-w-0 flex-1">
          <input
            autoFocus
            required
            maxLength={200}
            aria-label="Initiative name"
            placeholder="New initiative"
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
            className="h-7 w-full bg-transparent text-sm font-medium outline-none placeholder:text-muted-foreground/60"
          />
          <input
            maxLength={2000}
            aria-label="Initiative summary"
            placeholder="Add a short summary..."
            value={draft.summary}
            onChange={(event) =>
              setDraft({ ...draft, summary: event.target.value })
            }
            className="mt-1 h-6 w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/60"
          />
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {(["status", "priority", "owner", "target", "labels"] as const).map(
              (property) => (
                <InitiativePropertyPicker
                  key={property}
                  item={draft}
                  property={property}
                  people={people}
                  teams={teams}
                  labels={labels}
                  onChange={(patch) =>
                    setDraft((current) => ({ ...current, ...patch }))
                  }
                />
              )
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full text-xs"
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className={initiativePrimary}
                disabled={!draft.name.trim()}
              >
                Create
              </Button>
            </div>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              {error}
            </p>
          )}
        </div>
      </div>
    </form>
  )
}
