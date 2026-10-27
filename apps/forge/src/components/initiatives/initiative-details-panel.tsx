import { useId, useState } from "react"
import {
  InitiativeHealthMark,
  InitiativeMark,
  InitiativePropertyPicker,
} from "./initiative-properties"
import type { Initiative, InitiativePerson } from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import type { TeamLabel } from "@/lib/team-labels"
import { documentTime } from "@/lib/team-documents"
import { IssueIcon } from "@/components/issues/issue-controls"
import { ActionIconButton } from "@/components/ui/action-icon-button"
import { cn } from "@/lib/utils"

export function InitiativeDetailsPanel({
  item,
  people,
  teams,
  labels,
  writable,
  onPatch,
  onClose,
  onActivity,
}: {
  item: Initiative
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  labels: Array<TeamLabel>
  writable: boolean
  onPatch: (patch: Partial<Initiative>) => void
  onClose: () => void
  onActivity: (entryId?: string) => void
}) {
  const [propertiesOpen, setPropertiesOpen] = useState(true)
  const [activityOpen, setActivityOpen] = useState(true)
  const propertiesId = useId()
  const activityId = useId()
  const events = [
    ...item.updates.map((update) => ({ ...update, kind: "update" as const })),
    ...item.comments.map((comment) => ({
      ...comment,
      kind: "comment" as const,
    })),
  ]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 5)
  const name = (id: string) =>
    people.find((person) => person.id === id)?.name ?? "Former member"
  return (
    <aside
      aria-label="Initiative details sidebar"
      className="absolute inset-y-0 right-0 z-20 m-2 ml-0 flex w-[min(360px,calc(100%-16px))] shrink-0 flex-col gap-2 overflow-y-auto rounded-xl bg-background p-0 lg:static lg:w-[360px] lg:max-w-[35%] lg:bg-transparent"
    >
      <div className="flex justify-end px-2 pt-1 lg:hidden">
        <ActionIconButton label="Close details sidebar" onClick={onClose}>
          <IssueIcon name="close" />
        </ActionIconButton>
      </div>
      <section className="shrink-0 rounded-xl border border-border/25 bg-muted/45 p-3 dark:bg-[#1b1b1b]">
        <button
          aria-label={`${propertiesOpen ? "Collapse" : "Expand"} properties section`}
          aria-expanded={propertiesOpen}
          aria-controls={propertiesId}
          onClick={() => setPropertiesOpen((value) => !value)}
          className="mb-2 flex h-5 items-center gap-2 text-[13px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Properties
          <IssueIcon
            name="down"
            className={cn(
              "size-3 transition-transform",
              !propertiesOpen && "-rotate-90"
            )}
          />
        </button>
        {propertiesOpen && (
          <div id={propertiesId} className="space-y-1">
            {(
              [
                { property: "status", label: "Status" },
                { property: "priority", label: "Priority" },
                { property: "owner", label: "Owner" },
                { property: "target", label: "Target date" },
                { property: "labels", label: "Labels" },
              ] as const
            ).map((row) => (
              <div
                key={row.property}
                className="grid min-h-8 grid-cols-[80px_minmax(0,1fr)] items-center gap-2"
              >
                <span className="text-xs text-muted-foreground">
                  {row.label}
                </span>
                <div className="min-w-0">
                  <InitiativePropertyPicker
                    item={item}
                    property={row.property}
                    detail
                    addOnly={row.property === "labels"}
                    people={people}
                    teams={teams}
                    labels={labels}
                    onChange={onPatch}
                    disabled={!writable}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="shrink-0 rounded-xl border border-border/25 bg-muted/45 p-3 dark:bg-[#1b1b1b]">
        <div className="mb-2 flex items-center justify-between gap-3">
          <button
            aria-label={`${activityOpen ? "Collapse" : "Expand"} activity section`}
            aria-expanded={activityOpen}
            aria-controls={activityId}
            onClick={() => setActivityOpen((value) => !value)}
            className="flex h-5 items-center gap-2 text-[13px] text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Activity
            <IssueIcon
              name="down"
              className={cn(
                "size-3 transition-transform",
                !activityOpen && "-rotate-90"
              )}
            />
          </button>
          <button
            onClick={() => onActivity()}
            className="shrink-0 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            See all
          </button>
        </div>
        {activityOpen && (
          <div id={activityId} className="space-y-3 pt-1">
            {events.map((event) => (
              <button
                key={event.id}
                aria-label={`View ${name(event.authorId)} ${event.kind === "update" ? "update" : "comment"}`}
                onClick={() => onActivity(event.id)}
                className="flex w-full items-start gap-2 text-left text-[11px] leading-4 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {event.kind === "update" ? (
                  <InitiativeHealthMark health={event.health} iconOnly />
                ) : (
                  <IssueIcon
                    name="comment"
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                )}
                <span className="min-w-0">
                  <span className="text-foreground/85">
                    {name(event.authorId)}
                  </span>{" "}
                  {event.kind === "update" ? "posted an update" : "commented"} ·{" "}
                  <time
                    dateTime={event.createdAt}
                    title={new Date(event.createdAt).toLocaleString()}
                  >
                    {documentTime(event.createdAt)}
                  </time>
                </span>
              </button>
            ))}
            <div className="flex items-start gap-2 text-[11px] leading-4 text-muted-foreground">
              <InitiativeMark item={item} />
              <span>
                <span className="text-foreground/85">
                  {name(item.creatorId)}
                </span>{" "}
                created the initiative ·{" "}
                <time
                  dateTime={item.createdAt}
                  title={new Date(item.createdAt).toLocaleString()}
                >
                  {documentTime(item.createdAt)}
                </time>
              </span>
            </div>
          </div>
        )}
      </section>
    </aside>
  )
}
