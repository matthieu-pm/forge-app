import { InitiativeHealthMark } from "./initiative-properties"
import type {
  Initiative,
  InitiativeFilters,
  InitiativePerson,
  InitiativePreferences,
  InitiativeView,
} from "@/lib/initiatives"
import type { TeamSummary } from "@/lib/team-contract"
import {
  contributingTeamIds,
  initiativeHealth,
  visibleInitiatives,
} from "@/lib/initiatives"
import { AssigneeMark, IssueIcon } from "@/components/issues/issue-controls"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"

export function InitiativeSummary({
  items,
  view,
  filters,
  preferences,
  people,
  teams,
  schedule,
  onPreferences,
  onFilters,
  onClose,
}: {
  items: Array<Initiative>
  view: InitiativeView
  filters: InitiativeFilters
  preferences: InitiativePreferences
  people: Array<InitiativePerson>
  teams: Array<TeamSummary>
  schedule: string
  onPreferences: (next: InitiativePreferences) => void
  onFilters: (next: InitiativeFilters) => void
  onClose: () => void
}) {
  const field: "Owner" | "Health" | "Contributing teams" =
    preferences.sidebarTab === "Owner"
      ? "Owner"
      : preferences.sidebarTab === "Health"
        ? "Health"
        : "Contributing teams"
  const source = visibleInitiatives(
    items,
    view,
    { ...filters, rules: filters.rules.filter((rule) => rule.field !== field) },
    preferences,
    people,
    schedule
  )
  const counts = new Map<string, number>()
  for (const item of source)
    for (const value of field === "Owner"
      ? [item.ownerId]
      : field === "Health"
        ? [initiativeHealth(item, schedule)]
        : contributingTeamIds(item))
      counts.set(value, (counts.get(value) ?? 0) + 1)
  const label = (value: string) =>
    field === "Owner"
      ? (people.find((person) => person.id === value)?.name ??
        (value ? "Unknown member" : "No lead"))
      : field === "Health"
        ? value
        : (teams.find((team) => team.id === value)?.name ?? "Unknown team")
  return (
    <aside
      aria-label="Initiative summary"
      className="absolute inset-y-0 right-0 z-20 m-2 ml-0 flex w-[min(390px,calc(100%-16px))] shrink-0 flex-col rounded-xl border border-border/20 bg-popover p-3 shadow-lg lg:static lg:w-[390px] lg:max-w-[35%] lg:bg-muted/45 lg:shadow-none"
    >
      <div className="mb-1 flex justify-end lg:hidden">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close initiative summary"
          onClick={onClose}
        >
          <IssueIcon name="close" />
        </Button>
      </div>
      <Tabs
        value={preferences.sidebarTab}
        onValueChange={(tab) =>
          onPreferences({
            ...preferences,
            sidebarTab: tab as InitiativePreferences["sidebarTab"],
          })
        }
      >
        <TabsList
          aria-label="Initiative summary categories"
          className="h-7! w-full gap-1 rounded-none bg-transparent p-0"
        >
          {(["Owner", "Contributing team", "Health"] as const).map((tab) => (
            <TabsTrigger
              key={tab}
              value={tab}
              className="h-7 rounded-full border border-border/30! bg-muted/50 px-2 text-[11px] font-normal data-active:bg-foreground/15 dark:data-active:bg-foreground/15"
            >
              {tab}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="mt-4 min-h-0 flex-1 space-y-1 overflow-y-auto">
        {Array.from(counts)
          .sort((a, b) => b[1] - a[1] || label(a[0]).localeCompare(label(b[0])))
          .map(([value, count]) => {
            const chosen = filters.rules.some(
              (rule) =>
                rule.field === field &&
                (value
                  ? rule.operator === "is" && rule.value === value
                  : rule.operator === "is not set")
            )
            const person = people.find((member) => member.id === value)
            return (
              <button
                key={value}
                aria-label={`${label(value)}: ${count} initiatives`}
                aria-pressed={chosen}
                className={cn(
                  "flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                  chosen && "bg-muted"
                )}
                onClick={() =>
                  onFilters({
                    ...filters,
                    rules: [
                      ...filters.rules.filter((rule) => rule.field !== field),
                      ...(chosen
                        ? []
                        : [
                            {
                              id: crypto.randomUUID(),
                              field,
                              operator: value
                                ? ("is" as const)
                                : ("is not set" as const),
                              value,
                            },
                          ]),
                    ],
                  })
                }
              >
                {field === "Owner" ? (
                  <AssigneeMark name={person?.name} image={person?.image} />
                ) : field === "Health" ? (
                  <InitiativeHealthMark health={value} />
                ) : (
                  <IssueIcon name="person" />
                )}
                {field !== "Health" && (
                  <span className="min-w-0 flex-1 truncate">
                    {label(value)}
                  </span>
                )}
                <span className="ml-auto text-foreground">{count}</span>
              </button>
            )
          })}
        {!counts.size && (
          <p className="py-2 text-center text-xs text-muted-foreground">
            {field === "Contributing teams"
              ? "No contributing teams"
              : "No initiatives"}
          </p>
        )}
      </div>
    </aside>
  )
}
