import type { TriageIssue } from "@/lib/triage-issues"

export const filterFields = {
  assignee: "Assignee",
  priority: "Priority",
  labels: "Labels",
  project: "Project",
  dueDate: "Due date",
  createdAt: "Created date",
  content: "Content",
  description: "Description",
  links: "Links",
  templateName: "Template",
} as const
export type FilterField = keyof typeof filterFields
export type FilterOperator =
  | "is"
  | "isNot"
  | "contains"
  | "notContains"
  | "set"
  | "notSet"
  | "before"
  | "after"
export type TriageFilter = {
  id: string
  field: FilterField
  operator: FilterOperator
  value: string
}
export type TriageFilterState = { match: "all" | "any"; rules: Array<TriageFilter> }
export const emptyTriageFilters = (): TriageFilterState => ({
  match: "all",
  rules: [],
})
export const operatorLabels: Record<FilterOperator, string> = {
  is: "is",
  isNot: "is not",
  contains: "contains",
  notContains: "does not contain",
  set: "is set",
  notSet: "is not set",
  before: "is before",
  after: "is after",
}
export function fieldOperators(field: FilterField): Array<FilterOperator> {
  if (field === "links") return ["set", "notSet"]
  if (field === "dueDate" || field === "createdAt")
    return ["is", "before", "after", "set", "notSet"]
  if (field === "content" || field === "description")
    return ["contains", "notContains", "set", "notSet"]
  return ["is", "isNot", "set", "notSet"]
}
export function needsFilterValue(operator: FilterOperator) {
  return operator !== "set" && operator !== "notSet"
}
export function localDate(value: string) {
  const date = new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
export function matchesTriageFilters(
  issue: TriageIssue,
  filters: TriageFilterState
) {
  if (!filters.rules.length) return true
  const results = filters.rules.map((rule) => {
    const text =
      rule.field === "content"
        ? `${issue.title}\n${issue.description}`
        : rule.field === "links"
          ? /https?:\/\/\S+/i.test(`${issue.title}\n${issue.description}`)
            ? "link"
            : ""
          : rule.field === "createdAt"
            ? localDate(issue.createdAt)
            : (issue[rule.field] ?? "")
    const normalized = text.trim().toLocaleLowerCase()
    const expected = rule.value.trim().toLocaleLowerCase()
    const values =
      rule.field === "labels"
        ? normalized
            .split(",")
            .map((label) => label.trim())
            .filter(Boolean)
        : [normalized]
    switch (rule.operator) {
      case "set":
        return !!normalized
      case "notSet":
        return !normalized
      case "is":
        return values.includes(expected)
      case "isNot":
        return !values.includes(expected)
      case "contains":
        return normalized.includes(expected)
      case "notContains":
        return !normalized.includes(expected)
      case "before":
        return !!normalized && normalized < expected
      case "after":
        return !!normalized && normalized > expected
    }
  })
  return filters.match === "all"
    ? results.every(Boolean)
    : results.some(Boolean)
}
