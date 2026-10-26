import { getBreadcrumbItems } from "./app-navigation"
import type { BreadcrumbItem } from "./app-navigation"

// Settings chrome belongs to the shell, so page content cannot move it.
export function getSettingsBreadcrumbItems(
  pathname: string,
  team?: { name: string }
): Array<BreadcrumbItem> {
  const path = pathname.replace(/\/$/, "")
  const current = getBreadcrumbItems(path).at(-1) ?? { label: "Settings" }
  const items: Array<BreadcrumbItem> = [{ label: "Settings", to: "/settings" }]
  const teamMatch = /^\/settings\/teams\/([^/]+)(?:\/(.*))?$/.exec(path)

  if (path === "/settings/teams" || teamMatch) {
    items.push({ label: "Teams", to: "/settings/teams" })
    if (!teamMatch) return items
    if (teamMatch[1] === "new") return [...items, current]

    const base = `/settings/teams/${teamMatch[1]}`
    items.push({ label: team?.name ?? teamMatch[1], to: base })
    const section = teamMatch[2]
    if (!section) return items
    const parents: Record<string, string> = {
      templates: "Templates",
      "recurring-issues": "Recurring issues",
      "agent-skills": "Agent skills",
    }
    const parent = section.split("/")[0]
    if (parents[parent] && section.includes("/")) {
      items.push({ label: parents[parent], to: `${base}/${parent}` })
    }
  } else if (path.startsWith("/settings/notifications/")) {
    items.push({ label: "Notifications", to: "/settings/notifications" })
  } else {
    const template = /^\/settings\/templates\/(issue|project)\//.exec(path)
    if (template) {
      items.push({
        label:
          template[1] === "issue" ? "Issue templates" : "Project templates",
        to: `/settings/${template[1]}-templates`,
      })
    }
  }
  return [...items, current]
}
