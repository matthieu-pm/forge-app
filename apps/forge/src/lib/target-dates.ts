import { validInitiativeTarget } from "./initiatives"

/** Convert supported date precisions without depending on the browser's date parser. */
export function parseTargetDateInput(
  input: string,
  currentYear = new Date().getFullYear()
): string | null {
  const value = input.trim()
  if (!value) return ""
  if (validInitiativeTarget(value)) return value
  const period = value.match(/^(Q[1-4]|H[12])(?:\s+(\d{4}))?$/i)
  if (period) return `${period[2] || currentYear}-${period[1].toUpperCase()}`
  const american = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (american) {
    const next = `${american[3]}-${american[1].padStart(2, "0")}-${american[2].padStart(2, "0")}`
    return validInitiativeTarget(next) ? next : null
  }
  const month = value.match(/^([a-z]+)\s+(\d{4})$/i)
  if (month) {
    const names = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december",
    ]
    const index = names.findIndex(
      (name) =>
        name === month[1].toLowerCase() ||
        name.slice(0, 3) === month[1].toLowerCase()
    )
    if (index >= 0) return `${month[2]}-${String(index + 1).padStart(2, "0")}`
  }
  return null
}
