import type {
  LoopCondition,
  LoopLeafCondition,
  LoopTrigger,
} from "@/lib/loop-contract"
import { useCalendarWeek } from "@/hooks/use-calendar-week"
import { DateInput } from "@/components/ui/date-input"
import { usePersonName } from "@/components/person-name-provider"
import {
  LOOP_ENTITIES,
  eventProperties,
  loopConditionFields,
  loopConditionLeaves,
} from "@/lib/loop-contract"
import { loopLocalDateTime, loopScheduleStart } from "@/lib/loop-matching"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { OptionSelect } from "@/components/ui/option-select"

const label = "block space-y-2 text-sm"
const selectClass =
  "h-9 w-full rounded-lg border border-input bg-background px-2 text-sm"
function allowedEvents(entity: (typeof LOOP_ENTITIES)[number]) {
  if (entity === "cycle") return ["created", "started", "completed"] as const
  if (entity === "team") return ["created", "added", "removed"] as const
  return [
    "created",
    "updated",
    "changed",
    ...(entity === "initiative" ? [] : ["added" as const, "removed" as const]),
    "comment",
    ...(entity === "issue" ? [] : ["update" as const]),
    ...(entity === "issue" ? ["triage" as const] : []),
  ] as const
}
function initialEvent(
  entity: (typeof LOOP_ENTITIES)[number],
  event: Extract<LoopTrigger, { kind: "event" }>["event"]
): LoopTrigger {
  return {
    kind: "event",
    entity,
    event,
    ...(["added", "removed"].includes(event)
      ? {
          property:
            entity === "team" ? ("members" as const) : ("labels" as const),
        }
      : event === "changed"
        ? { property: eventProperties[entity][0] ?? ("status" as const) }
        : {}),
  }
}
function ValuePicker({
  values,
  onChange,
  choices,
  name,
  optional = false,
}: {
  values: Array<string>
  onChange: (values: Array<string>) => void
  choices?: Array<{ id: string; name: string }>
  name: string
  optional?: boolean
}) {
  if (!choices)
    return (
      <Input
        aria-label={name}
        value={values.join(", ")}
        placeholder={optional ? "Any value" : "Enter a value"}
        onChange={(event) =>
          onChange(event.target.value ? [event.target.value] : [])
        }
      />
    )
  return (
    <div className="min-w-40 flex-1 space-y-2">
      <div className="flex flex-wrap gap-1">
        {values.filter(Boolean).map((value) => (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            key={value}
            aria-label={`Remove ${choices.find((choice) => choice.id === value)?.name ?? "unavailable selection"}`}
            onClick={() => onChange(values.filter((v) => v !== value))}
          >
            {choices.find((choice) => choice.id === value)?.name ??
              "Unavailable selection"}{" "}
            ×
          </Button>
        ))}
      </div>
      <OptionSelect
        aria-label={name}
        className={selectClass}
        value=""
        onValueChange={(value) => {
          if (value && !values.includes(value))
            onChange([...values.filter(Boolean), value])
        }}
      >
        <option value="">
          {choices.length
            ? optional
              ? "Any value; narrow by selecting…"
              : "Choose a value…"
            : "No available values"}
        </option>
        {choices
          .filter((choice) => !values.includes(choice.id))
          .map((choice) => (
            <option value={choice.id} key={choice.id}>
              {choice.name}
            </option>
          ))}
      </OptionSelect>
    </div>
  )
}
export function LoopConditionEditor({
  conditions,
  onChange,
  entity,
  choices,
  depth = 0,
  total,
}: {
  conditions: Array<LoopCondition>
  onChange: (conditions: Array<LoopCondition>) => void
  entity: (typeof LOOP_ENTITIES)[number]
  choices?: Record<string, Array<{ id: string; name: string }>>
  depth?: number
  total?: number
}) {
  const personName = usePersonName()
  const presentedChoices =
    choices &&
    Object.fromEntries(
      Object.entries(choices).map(([key, entries]) => [
        key,
        ["assignee", "creator", "owner", "lead"].includes(key)
          ? entries.map((person) =>
              person.id === "__none__"
                ? person
                : { ...person, name: personName(person) }
            )
          : entries,
      ])
    )
  const group =
    conditions.length === 1 && "conditions" in conditions[0]
      ? conditions[0]
      : null
  const items = group?.conditions ?? conditions,
    mode = group?.operator ?? "and",
    count = total ?? loopConditionLeaves(conditions).length
  const update = (next: Array<LoopCondition>) =>
    onChange(
      mode === "or" || depth > 0 ? [{ operator: mode, conditions: next }] : next
    )
  const supported = loopConditionFields[entity]
  const fieldChoices = (field: LoopLeafCondition["field"]) =>
    field === "triage"
      ? [
          { id: "true", name: "In triage" },
          { id: "false", name: "Outside triage" },
        ]
      : (presentedChoices?.[`${entity}.${field}`] ??
        presentedChoices?.[
          field === "id"
            ? entity
            : field === "members"
              ? "assignee"
              : field === "projects"
                ? "project"
                : field
        ])
  return (
    <div className="space-y-3">
      <OptionSelect
        aria-label={depth ? `Group ${depth} matching` : "Condition matching"}
        className={selectClass}
        value={mode}
        onValueChange={(operator) =>
          onChange(
            operator === "or" || depth > 0
              ? [{ operator: operator as "and" | "or", conditions: items }]
              : items
          )
        }
      >
        <option value="and">All conditions must match</option>
        <option value="or">Any condition can match</option>
      </OptionSelect>
      {items.map((condition, index) =>
        "conditions" in condition ? (
          <div
            className="space-y-2 rounded-lg border border-border p-3"
            key={index}
          >
            <LoopConditionEditor
              conditions={[condition]}
              onChange={(next) =>
                update(
                  items.flatMap((item, i) => (i === index ? next : [item]))
                )
              }
              entity={entity}
              choices={choices}
              depth={depth + 1}
              total={count}
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() => update(items.filter((_, i) => i !== index))}
            >
              Remove group
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-start gap-2" key={index}>
            <OptionSelect
              aria-label={`Condition ${index + 1} field`}
              className={selectClass + " flex-1"}
              value={condition.field}
              onValueChange={(field) =>
                update(
                  items.map((c, i) =>
                    i === index
                      ? {
                          field: field as LoopLeafCondition["field"],
                          operator: "is",
                          values: [],
                        }
                      : c
                  )
                )
              }
            >
              {supported.map((field) => (
                <option key={field}>{field}</option>
              ))}
            </OptionSelect>
            <OptionSelect
              aria-label={`Condition ${index + 1} operator`}
              className={selectClass + " flex-1"}
              value={condition.operator}
              onValueChange={(operator) =>
                update(
                  items.map((c, i) =>
                    i === index
                      ? {
                          ...condition,
                          operator: operator as LoopLeafCondition["operator"],
                        }
                      : c
                  )
                )
              }
            >
              {["is", "isNot", "any", "none", "contains"].map((operator) => (
                <option key={operator}>{operator}</option>
              ))}
            </OptionSelect>
            <ValuePicker
              name={`Condition ${index + 1} values`}
              values={condition.values}
              choices={fieldChoices(condition.field)}
              onChange={(values) =>
                update(
                  items.map((c, i) =>
                    i === index ? { ...condition, values } : c
                  )
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              aria-label={`Remove condition ${index + 1}`}
              onClick={() => update(items.filter((_, i) => i !== index))}
            >
              Remove
            </Button>
          </div>
        )
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={count >= 8}
          onClick={() =>
            update([
              ...items,
              {
                field: entity === "issue" ? "priority" : "name",
                operator: "is",
                values: [],
              },
            ])
          }
        >
          Add condition
        </Button>
        {depth < 3 && (
          <Button
            type="button"
            variant="ghost"
            disabled={count >= 8}
            onClick={() =>
              update([
                ...items,
                {
                  operator: "or",
                  conditions: [
                    {
                      field: entity === "issue" ? "priority" : "name",
                      operator: "is",
                      values: [],
                    },
                  ],
                },
              ])
            }
          >
            Add group
          </Button>
        )}
      </div>
    </div>
  )
}
export function LoopTriggerEditor({
  value,
  onChange,
  timeZone,
  choices,
}: {
  value: LoopTrigger
  onChange: (trigger: LoopTrigger) => void
  timeZone: string
  choices?: Record<string, Array<{ id: string; name: string }>>
}) {
  const personName = usePersonName()
  const presentedChoices =
    choices &&
    Object.fromEntries(
      Object.entries(choices).map(([key, entries]) => [
        key,
        ["assignee", "creator", "owner", "lead"].includes(key)
          ? entries.map((person) =>
              person.id === "__none__"
                ? person
                : { ...person, name: personName(person) }
            )
          : entries,
      ])
    )
  const propertyOptions =
    value.kind === "event" && value.property
      ? (presentedChoices?.[`${value.entity}.${value.property}`] ??
        presentedChoices?.[
          value.property === "members" ? "assignee" : value.property
        ])
      : undefined
  const triggerOptions =
    value.kind === "event" && ["added", "removed"].includes(value.event)
      ? propertyOptions?.filter((choice) => choice.id !== "__none__")
      : propertyOptions
  const { weekdays } = useCalendarWeek()
  return (
    <div className="space-y-3">
      <label className={label}>
        Trigger
        <OptionSelect
          aria-label="Loop trigger type"
          className={selectClass}
          value={value.kind}
          onValueChange={(kind) =>
            onChange(
              kind === "schedule"
                ? {
                    kind,
                    unit: "days",
                    interval: 1,
                    startAt: new Date(
                      (Math.floor(Date.now() / 3600000) + 1) * 3600000
                    ).toISOString(),
                    timeZone,
                  }
                : kind === "webhook"
                  ? { kind }
                  : { kind: "event", entity: "issue", event: "created" }
            )
          }
        >
          <option value="event">Workspace event</option>
          <option value="schedule">Schedule</option>
          <option value="webhook">Authenticated webhook</option>
        </OptionSelect>
      </label>
      {value.kind === "event" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <label className={label}>
              Entity
              <OptionSelect
                aria-label="Trigger entity"
                className={selectClass}
                value={value.entity}
                onValueChange={(entity) =>
                  onChange({
                    kind: "event",
                    entity: entity as typeof value.entity,
                    event: "created",
                  })
                }
              >
                {LOOP_ENTITIES.map((entity) => (
                  <option key={entity} value={entity}>
                    {entity}
                  </option>
                ))}
              </OptionSelect>
            </label>
            <label className={label}>
              Event
              <OptionSelect
                aria-label="Trigger event"
                className={selectClass}
                value={value.event}
                onValueChange={(event) =>
                  onChange(
                    initialEvent(value.entity, event as typeof value.event)
                  )
                }
              >
                {allowedEvents(value.entity).map((event) => (
                  <option key={event} value={event}>
                    {event === "triage"
                      ? "Begins matching in triage"
                      : event === "added"
                        ? value.entity === "team"
                          ? "Member joins"
                          : "Label added"
                        : event === "removed"
                          ? value.entity === "team"
                            ? "Member leaves"
                            : "Label removed"
                          : event === "update"
                            ? "Update posted"
                            : event === "updated"
                              ? "Property updated"
                              : event}
                  </option>
                ))}
              </OptionSelect>
            </label>
          </div>
          {value.event === "changed" && (
            <label className={label}>
              Property
              <OptionSelect
                aria-label="Watched property"
                value={value.property ?? ""}
                className={selectClass}
                onValueChange={(property) =>
                  onChange({
                    ...value,
                    property: property as typeof value.property,
                  })
                }
              >
                {eventProperties[value.entity].map((property) => (
                  <option key={property}>{property}</option>
                ))}
              </OptionSelect>
            </label>
          )}
          {["changed", "added", "removed"].includes(value.event) && (
            <label className={label}>
              {value.event === "changed"
                ? "Destination values"
                : "Changed values"}
              <ValuePicker
                name="Trigger values"
                optional
                values={value.values ?? []}
                choices={triggerOptions}
                onChange={(values) => onChange({ ...value, values })}
              />
            </label>
          )}
          {value.event === "comment" && (
            <>
              <label className={label}>
                Comments
                <OptionSelect
                  aria-label="Comment matching"
                  className={selectClass}
                  value={value.commentMode ?? "any"}
                  onValueChange={(commentMode) =>
                    onChange({
                      ...value,
                      commentMode: commentMode as typeof value.commentMode,
                      commentText: undefined,
                      mentionIds: undefined,
                    })
                  }
                >
                  <option value="any">Any comment, including replies</option>
                  <option value="newThread">New top-level comment</option>
                  <option value="contains">Contains text</option>
                  <option value="mentions">Mentions a member</option>
                </OptionSelect>
              </label>
              {value.commentMode === "contains" && (
                <label className={label}>
                  Text to match
                  <Input
                    aria-label="Comment text to match"
                    value={value.commentText ?? ""}
                    maxLength={1000}
                    onChange={(event) =>
                      onChange({ ...value, commentText: event.target.value })
                    }
                  />
                </label>
              )}
              {value.commentMode === "mentions" && (
                <label className={label}>
                  Mentioned members
                  <ValuePicker
                    name="Mentioned members"
                    choices={presentedChoices?.assignee ?? []}
                    values={value.mentionIds ?? []}
                    onChange={(mentionIds) =>
                      onChange({ ...value, mentionIds })
                    }
                  />
                </label>
              )}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            Use conditions to narrow matching events; multiple values within a
            condition match any selected value.
          </p>
        </>
      )}
      {value.kind === "schedule" && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <label className={label}>
              Every
              <Input
                type="number"
                aria-label="Schedule interval"
                min={1}
                max={1000}
                value={value.interval}
                onChange={(event) =>
                  onChange({ ...value, interval: Number(event.target.value) })
                }
              />
            </label>
            <label className={label}>
              Unit
              <OptionSelect
                aria-label="Schedule unit"
                className={selectClass}
                value={value.unit}
                onValueChange={(unit) =>
                  onChange({
                    ...value,
                    unit: unit as typeof value.unit,
                    weekdays: unit === "weeks" ? [1] : undefined,
                  })
                }
              >
                {["hours", "days", "weeks", "months", "years"].map((unit) => (
                  <option key={unit}>{unit}</option>
                ))}
              </OptionSelect>
            </label>
          </div>
          <label className={label}>
            Timezone
            <Input
              aria-label="Schedule timezone"
              value={value.timeZone}
              onChange={(event) =>
                onChange({ ...value, timeZone: event.target.value })
              }
              placeholder="Europe/Paris"
            />
          </label>
          <label className={label}>
            First run (in the selected timezone)
            <DateInput
              aria-label="First scheduled run"
              type="datetime-local"
              value={(() => {
                try {
                  return loopLocalDateTime(
                    new Date(value.startAt),
                    value.timeZone
                  )
                } catch {
                  return ""
                }
              })()}
              onValueChange={(dateValue) => {
                try {
                  onChange({
                    ...value,
                    startAt: loopScheduleStart(dateValue, value.timeZone),
                  })
                } catch {
                  /* Retain last valid date until input is complete. */
                }
              }}
            />
          </label>
          {value.unit === "weeks" && (
            <fieldset>
              <legend className="mb-2 text-sm">Weekdays</legend>
              <div className="flex flex-wrap gap-3">
                {weekdays.map((dayIndex) => {
                  const weekday = dayIndex || 7
                  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
                    dayIndex
                  ]
                  return (
                    <label
                      className="flex items-center gap-1 text-sm"
                      key={day}
                    >
                      <input
                        type="checkbox"
                        checked={value.weekdays?.includes(weekday) ?? false}
                        onChange={(event) =>
                          onChange({
                            ...value,
                            weekdays: event.target.checked
                              ? [...(value.weekdays ?? []), weekday]
                              : value.weekdays?.filter((v) => v !== weekday),
                          })
                        }
                      />
                      {day}
                    </label>
                  )
                })}
              </div>
            </fieldset>
          )}
          <p className="text-xs text-muted-foreground">
            Calendar schedules follow this timezone. Missed runs coalesce into
            one pending occurrence.
          </p>
        </>
      )}
      {value.kind === "webhook" && (
        <p className="text-sm text-muted-foreground">
          After saving, generate a webhook secret. Send JSON by POST with
          Authorization: Bearer &lt;secret&gt; and a unique Webhook-Id. Retries
          must reuse the same ID and payload. Acceptance confirms receipt;
          execution appears in run history.
        </p>
      )}
    </div>
  )
}
