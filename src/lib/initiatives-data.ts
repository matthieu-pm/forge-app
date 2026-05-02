export type InitiativeStatus = "active" | "planned" | "completed"

export type InitiativeHealth = "on-track" | "at-risk" | "off-track" | "no-updates"

export type InitiativeOwner = {
  id: string
  name: string
  initials: string
  color: string
}

export type Project = {
  id: string
  name: string
  completed: boolean
}

export type Initiative = {
  id: string
  name: string
  description: string
  ownerId: string | null
  targetDate: string | null
  projectIds: string[]
  status: InitiativeStatus
  health: InitiativeHealth
  accentColor: string
}

export const MOCK_OWNERS: InitiativeOwner[] = [
  { id: "u-mengde", name: "mengde", initials: "M", color: "bg-amber-200" },
  { id: "u-alex", name: "alex", initials: "A", color: "bg-rose-200" },
  { id: "u-sam", name: "sam", initials: "S", color: "bg-sky-200" },
  { id: "u-priya", name: "priya", initials: "P", color: "bg-emerald-200" },
]

export const MOCK_PROJECTS: Project[] = [
  { id: "p-1", name: "Onboarding flow", completed: false },
  { id: "p-2", name: "Public API v1", completed: true },
  { id: "p-3", name: "Billing portal", completed: false },
  { id: "p-4", name: "Mobile shell", completed: false },
  { id: "p-5", name: "Auth hardening", completed: true },
  { id: "p-6", name: "Notifications", completed: false },
  { id: "p-7", name: "Search index", completed: false },
  { id: "p-8", name: "Analytics dashboard", completed: false },
  { id: "p-9", name: "Plan upgrade UX", completed: false },
  { id: "p-10", name: "Team invites", completed: true },
  { id: "p-11", name: "SSO support", completed: false },
]

export const SAMPLE_INITIATIVES: Initiative[] = [
  {
    id: "i-forge-mvp",
    name: "Forge {MVP}",
    description:
      "Complete the must-have product, ops, and readiness work needed to ship the MVP confidently.",
    ownerId: "u-mengde",
    targetDate: "2026-05-31",
    projectIds: ["p-1", "p-2", "p-3", "p-4", "p-5", "p-6", "p-7", "p-8", "p-9", "p-10", "p-11"],
    status: "active",
    health: "no-updates",
    accentColor: "bg-rose-500",
  },
  {
    id: "i-finalize-mvp",
    name: "Finalize MVP",
    description:
      "Complete the must-have product, ops, and readiness work needed to ship the MVP confidently.",
    ownerId: "u-mengde",
    targetDate: "2026-05-01",
    projectIds: ["p-2", "p-3"],
    status: "active",
    health: "no-updates",
    accentColor: "bg-zinc-800",
  },
  {
    id: "i-launch-beta",
    name: "Launch Beta {v1.0}",
    description:
      "Prepare, launch, and stabilize the beta {v1.0} release with onboarding, feedback, and production readiness in place.",
    ownerId: "u-mengde",
    targetDate: "2026-05-01",
    projectIds: ["p-4", "p-5", "p-6"],
    status: "active",
    health: "no-updates",
    accentColor: "bg-rose-500",
  },
]

export function getOwner(
  ownerId: string | null,
  owners: InitiativeOwner[] = MOCK_OWNERS
): InitiativeOwner | null {
  if (!ownerId) return null
  return owners.find((o) => o.id === ownerId) ?? null
}

export function getProjects(
  projectIds: string[],
  projects: Project[] = MOCK_PROJECTS
): Project[] {
  const lookup = new Map(projects.map((p) => [p.id, p]))
  return projectIds
    .map((id) => lookup.get(id))
    .filter((p): p is Project => Boolean(p))
}

export function formatTargetDate(iso: string | null): string {
  if (!iso) return ""
  const d = new Date(iso + "T00:00:00")
  if (Number.isNaN(d.getTime())) return ""
  const month = d.toLocaleString("en-US", { month: "short" })
  const day = d.getDate()
  const suffix = ordinalSuffix(day)
  return `${month} ${day}${suffix}`
}

function ordinalSuffix(n: number): string {
  const j = n % 10
  const k = n % 100
  if (j === 1 && k !== 11) return "st"
  if (j === 2 && k !== 12) return "nd"
  if (j === 3 && k !== 13) return "rd"
  return "th"
}

export function isPastDate(iso: string | null): boolean {
  if (!iso) return false
  const d = new Date(iso + "T00:00:00")
  if (Number.isNaN(d.getTime())) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return d.getTime() < today.getTime()
}
