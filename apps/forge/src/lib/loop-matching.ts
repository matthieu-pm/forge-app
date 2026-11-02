import type {
  LoopCondition,
  LoopEntity,
  LoopFields,
  LoopLeafCondition,
  LoopTrigger,
} from "./loop-contract"

type Value = string | number | boolean | null | Array<string | number | boolean>
export type LoopEntitySnapshot = Partial<
  Record<LoopLeafCondition["field"], Value>
>
export type LoopEvent = {
  entity: LoopEntity
  event: "created" | "updated" | "comment" | "update" | "started" | "completed"
  before: LoopEntitySnapshot | null
  after: LoopEntitySnapshot
  comment?: {
    text: string
    parentId?: string | null
    mentionIds?: Array<string>
  }
}
const values = (value: Value | undefined) =>
  value === undefined || value === null || value === ""
    ? []
    : (Array.isArray(value) ? value : [value]).map(String)
function matchesSelected(selected: Array<string>, actual: Array<string>) {
  return selected.some((value) =>
    value === "__none__" ? actual.length === 0 : actual.includes(value)
  )
}
export function matchesLoopConditions(
  conditions: Array<LoopCondition>,
  entity: LoopEntitySnapshot
) {
  const match = (condition: LoopCondition): boolean => {
    if ("conditions" in condition)
      return condition.operator === "and"
        ? condition.conditions.every(match)
        : condition.conditions.some(match)
    const actual = values(entity[condition.field]),
      includes = matchesSelected(condition.values, actual)
    if (condition.operator === "is" || condition.operator === "any")
      return includes
    if (condition.operator === "isNot" || condition.operator === "none")
      return !includes
    return actual.some((value) =>
      value.toLowerCase().includes(condition.values[0].toLowerCase())
    )
  }
  return conditions.every(match)
}
export function matchesLoopEvent(
  fields: Pick<LoopFields, "trigger" | "conditions">,
  event: LoopEvent
) {
  const trigger = fields.trigger
  if (
    trigger.kind !== "event" ||
    trigger.entity !== event.entity ||
    !matchesLoopConditions(fields.conditions, event.after)
  )
    return false
  if (trigger.event === "comment") {
    if (event.event !== "comment") return false
    if (trigger.commentMode === "newThread")
      return Boolean(event.comment) && !event.comment?.parentId
    if (trigger.commentMode === "contains")
      return Boolean(
        event.comment?.text
          .toLowerCase()
          .includes((trigger.commentText ?? "").toLowerCase())
      )
    if (trigger.commentMode === "mentions")
      return Boolean(
        trigger.mentionIds?.some((id) =>
          event.comment?.mentionIds?.includes(id)
        )
      )
    return true
  }
  if (trigger.event === "triage")
    return (
      event.after.triage === true &&
      !(
        event.before?.triage === true &&
        matchesLoopConditions(fields.conditions, event.before)
      )
    )
  if (
    [
      "created",
      "updated",
      "comment",
      "update",
      "started",
      "completed",
    ].includes(trigger.event)
  )
    return trigger.event === event.event
  if (event.event !== "updated" || !event.before || !trigger.property)
    return false
  const before = values(event.before[trigger.property]),
    after = values(event.after[trigger.property])
  if (trigger.event === "changed")
    return (
      JSON.stringify(before) !== JSON.stringify(after) &&
      (!trigger.values?.length || matchesSelected(trigger.values, after))
    )
  const changed =
    trigger.event === "added"
      ? after.filter((value) => !before.includes(value))
      : before.filter((value) => !after.includes(value))
  return (
    changed.length > 0 &&
    (!trigger.values?.length ||
      changed.some(
        (value) =>
          value !== "__none__" &&
          trigger
            .values!.filter((qualifier) => qualifier !== "__none__")
            .includes(value)
      ))
  )
}

type Schedule = Extract<LoopTrigger, { kind: "schedule" }>
type Parts = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}
function parts(date: Date, timeZone: string): Parts {
  const raw = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date)
  return Object.fromEntries(
    raw
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)])
  ) as Parts
}
const stamp = (p: Parts) =>
  Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
const dayStamp = (p: Parts) => Date.UTC(p.year, p.month - 1, p.day)
const dayMs = 86400000
function calendar(local: Parts, days: number): Parts {
  const date = new Date(dayStamp(local) + days * dayMs)
  return {
    ...local,
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  }
}
function instant(local: Parts, timeZone: string) {
  // Try both sides of a possible DST boundary. For a gap, move forward by the
  // transition; for a repeated local time, choose the earlier occurrence once.
  const target = stamp(local),
    guesses = [-36, 0, 36].map((hours) => {
      const probe = target + hours * 3600000
      return target - (stamp(parts(new Date(probe), timeZone)) - probe)
    })
  const exact = guesses.filter(
    (candidate) => stamp(parts(new Date(candidate), timeZone)) === target
  )
  if (exact.length) return new Date(Math.min(...exact))
  const later = guesses.filter(
    (candidate) => stamp(parts(new Date(candidate), timeZone)) > target
  )
  return new Date(Math.min(...(later.length ? later : guesses)))
}
/** Strictly after `after`, anchored to the original start; missed ticks coalesce. */
export function nextLoopScheduledAt(schedule: Schedule, after: Date): Date {
  const start = new Date(schedule.startAt)
  if (!Number.isFinite(after.getTime()) || !Number.isFinite(start.getTime()))
    throw new Error("Invalid schedule date.")
  if (schedule.unit === "hours") {
    const step = schedule.interval * 3600000
    return new Date(
      start.getTime() +
        Math.max(
          0,
          Math.floor((after.getTime() - start.getTime()) / step) + 1
        ) *
          step
    )
  }
  const anchor = parts(start, schedule.timeZone),
    current = parts(after, schedule.timeZone)
  if (schedule.unit === "days") {
    const elapsed = Math.floor((dayStamp(current) - dayStamp(anchor)) / dayMs)
    let ordinal = Math.max(0, Math.floor(elapsed / schedule.interval))
    for (;;) {
      const result = instant(
        calendar(anchor, ordinal++ * schedule.interval),
        schedule.timeZone
      )
      if (result >= start && result > after) return result
    }
  }
  if (schedule.unit === "weeks") {
    const weekday = (new Date(dayStamp(anchor)).getUTCDay() + 6) % 7
    const monday = calendar(anchor, -weekday)
    const elapsedWeeks = Math.floor(
      (dayStamp(current) - dayStamp(monday)) / (7 * dayMs)
    )
    let ordinal = Math.max(0, Math.floor(elapsedWeeks / schedule.interval))
    const weekdays = [...(schedule.weekdays ?? [])].sort((a, b) => a - b)
    if (!weekdays.length) throw new Error("A weekly schedule needs weekdays.")
    for (;;) {
      for (const day of weekdays) {
        const result = instant(
          calendar(monday, ordinal * schedule.interval * 7 + day - 1),
          schedule.timeZone
        )
        if (result >= start && result > after) return result
      }
      ordinal++
    }
  }
  const monthStep = schedule.interval * (schedule.unit === "years" ? 12 : 1)
  const elapsedMonths =
    (current.year - anchor.year) * 12 + current.month - anchor.month
  let ordinal = Math.max(0, Math.floor(elapsedMonths / monthStep))
  for (;;) {
    const monthIndex =
      anchor.year * 12 + anchor.month - 1 + ordinal++ * monthStep
    const year = Math.floor(monthIndex / 12),
      month = (monthIndex % 12) + 1
    const day = Math.min(
      anchor.day,
      new Date(Date.UTC(year, month, 0)).getUTCDate()
    )
    const result = instant({ ...anchor, year, month, day }, schedule.timeZone)
    if (result >= start && result > after) return result
  }
}
export function loopLocalDateTime(date: Date, timeZone: string) {
  const p = parts(date, timeZone),
    pad = (value: number) => String(value).padStart(2, "0")
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`
}
export function loopScheduleStart(local: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local)
  if (!match) throw new Error("Choose a valid first run date and time.")
  const [, year, month, day, hour, minute] = match.map(Number)
  const candidate = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (
    year < 1000 ||
    year > 9999 ||
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  )
    throw new Error("Choose a valid first run date and time.")
  const result = instant(
    { year, month, day, hour, minute, second: 0 },
    timeZone
  )
  if (!Number.isFinite(result.getTime()))
    throw new Error("Choose a valid first run date and time.")
  return result.toISOString()
}
