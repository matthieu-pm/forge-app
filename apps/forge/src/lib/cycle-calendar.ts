// Calendar dates are inclusive in the stored IANA zone, never instants in a viewer's zone.
export function cycleToday(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now)
  const part = (type: string) => parts.find((p) => p.type === type)!.value
  return `${part("year")}-${part("month")}-${part("day")}`
}
export function addCycleDays(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
export function nextCycleDate(
  date: string,
  weekday: number,
  strictlyAfter = true
) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay()
  const delta = (weekday - day + 7) % 7
  return addCycleDays(date, delta || (strictlyAfter ? 7 : 0))
}
