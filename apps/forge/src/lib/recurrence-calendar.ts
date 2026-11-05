import type { RecurringIssueDraft } from "./recurring-issue-contract"

type Schedule = Pick<
  RecurringIssueDraft,
  "firstDue" | "unit" | "interval" | "timezone" | "generationTime"
>
const formatters = new Map<string, Intl.DateTimeFormat>()
function localStamp(instant: number, timezone: string) {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
    formatters.set(timezone, formatter)
  }
  const parts = formatter.formatToParts(new Date(instant))
  const get = (type: string) => parts.find((part) => part.type === type)!.value
  return Date.parse(
    `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}Z`
  )
}

/** Earlier on folds; shift forward by the offset change on gaps. */
export function recurrenceInstant(
  date: string,
  time: string,
  timezone: string
) {
  const target = Date.parse(`${date}T${time}:00Z`)
  const offsets = new Set<number>()
  for (let hours = -48; hours <= 48; hours += 12) {
    const sample = target + hours * 3600000
    offsets.add(localStamp(sample, timezone) - sample)
  }
  const candidates = [...offsets].map((offset) => target - offset)
  const exact = candidates.filter(
    (candidate) => localStamp(candidate, timezone) === target
  )
  if (exact.length) return new Date(Math.min(...exact))
  const forward = candidates.filter(
    (candidate) => localStamp(candidate, timezone) > target
  )
  if (!forward.length)
    throw new Error("Could not interpret the recurring local time.")
  forward.sort((a, b) => localStamp(a, timezone) - localStamp(b, timezone))
  return new Date(forward[0])
}

export function recurrenceDate(schedule: Schedule, index: number) {
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error("Invalid recurrence index.")
  const anchor = new Date(`${schedule.firstDue}T12:00:00Z`)
  const amount = schedule.interval * index
  if (schedule.unit === "day" || schedule.unit === "week") {
    anchor.setUTCDate(
      anchor.getUTCDate() + amount * (schedule.unit === "week" ? 7 : 1)
    )
  } else {
    const day = anchor.getUTCDate()
    anchor.setUTCDate(1)
    anchor.setUTCMonth(
      anchor.getUTCMonth() + amount * (schedule.unit === "year" ? 12 : 1)
    )
    const last = new Date(anchor)
    last.setUTCMonth(last.getUTCMonth() + 1, 0)
    anchor.setUTCDate(Math.min(day, last.getUTCDate()))
  }
  if (!Number.isFinite(anchor.getTime()) || anchor.getUTCFullYear() > 9999)
    throw new Error("The recurrence exceeds the supported calendar.")
  return anchor.toISOString().slice(0, 10)
}
export function occurrenceAt(schedule: Schedule, index: number) {
  return recurrenceInstant(
    recurrenceDate(schedule, index),
    schedule.generationTime ?? "09:00",
    schedule.timezone ?? "UTC"
  )
}

/** Binary search keeps multi-year downtime bounded without enumerating every date. */
export function nextRecurrenceIndex(
  schedule: Schedule,
  now: Date,
  minimum = 1
) {
  let low = minimum,
    high = minimum
  while (occurrenceAt(schedule, high) <= now) {
    low = high + 1
    high = Math.max(high + 1, high * 2)
  }
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (occurrenceAt(schedule, middle) <= now) low = middle + 1
    else high = middle
  }
  return low
}
