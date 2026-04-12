import type { ComponentProps } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AirplayLineIcon,
  Asteroid02Icon,
  Call02Icon,
  CenterFocusIcon,
  ClipboardIcon,
  CodepenIcon,
  CubeIcon,
  InboxUnreadIcon,
  UserGroup03Icon,
  UserIdVerificationIcon,
} from "@hugeicons/core-free-icons"

type AppIcon = ComponentProps<typeof HugeiconsIcon>["icon"]
type TeamSlug = "product" | "engineering" | "operations"
type TeamSection = "projects" | "issues" | "signals" | "calls" | "insights"
type TeamPath = `/teams/${TeamSlug}/${TeamSection}`

export type AppPath =
  | "/forge"
  | "/inbox"
  | "/my-issues"
  | "/workspace/initiatives"
  | "/workspace/projects"
  | "/workspace/calls"
  | "/workspace/signals"
  | "/workspace/insights"
  | "/workspace/views"
  | "/workspace/teams"
  | "/workspace/members"
  | "/agent"
  | TeamPath

export type AppNavChild = {
  title: string
  to: AppPath
  icon?: AppIcon
  iconSrc?: string
  items?: AppNavChild[]
}

export type AppNavItem = {
  title: string
  to: AppPath
  icon?: AppIcon
  iconSrc?: string
  items?: AppNavChild[]
}

type PageMeta = {
  eyebrow: string
  title: string
  description: string
}

export type BreadcrumbItem = {
  label: string
  to?: string
}

const teamDefinitions = [
  { title: "Product", slug: "product" },
  { title: "Engineering", slug: "engineering" },
  { title: "Operations", slug: "operations" },
] as const

const teamSectionDefinitions = [
  { title: "Projects", section: "projects", icon: CubeIcon },
  { title: "Issues", section: "issues", icon: ClipboardIcon },
  { title: "Signals", section: "signals", icon: Asteroid02Icon },
  { title: "Calls", section: "calls", icon: Call02Icon },
  { title: "Insights", section: "insights", icon: CodepenIcon },
] as const

function getTeamPath(slug: TeamSlug, section: TeamSection): TeamPath {
  return `/teams/${slug}/${section}`
}

export const workspaceNav: AppNavChild[] = [
  {
    title: "Initiatives",
    to: "/workspace/initiatives",
    icon: AirplayLineIcon,
  },
  { title: "Projects", to: "/workspace/projects", icon: CubeIcon },
  { title: "Signals", to: "/workspace/signals", icon: Asteroid02Icon },
  { title: "Calls", to: "/workspace/calls", icon: Call02Icon },
  { title: "Insights", to: "/workspace/insights", icon: CodepenIcon },
  { title: "Teams", to: "/workspace/teams", icon: UserIdVerificationIcon },
  { title: "Members", to: "/workspace/members", icon: UserGroup03Icon },
]

export const yourTeamsNav: AppNavChild[] = teamDefinitions.map((team) => ({
  title: team.title,
  to: getTeamPath(team.slug, "projects"),
  items: teamSectionDefinitions.map((section) => ({
    title: section.title,
    to: getTeamPath(team.slug, section.section),
    icon: section.icon,
  })),
}))

export const appNav: AppNavItem[] = [
  {
    title: "Inbox",
    to: "/inbox",
    icon: InboxUnreadIcon,
  },
  {
    title: "Forge",
    to: "/forge",
    iconSrc: "/img/logo-forge-black.png",
  },
  {
    title: "My issues",
    to: "/my-issues",
    icon: CenterFocusIcon,
  },
  {
    title: "Workspace",
    to: "/workspace/initiatives",
    items: workspaceNav,
  },
  {
    title: "Your teams",
    to: getTeamPath("product", "projects"),
    items: yourTeamsNav,
  },
]

const pageMetaByPath: Partial<Record<AppPath, PageMeta>> = {
  "/forge": {
    eyebrow: "Home",
    title: "Forge",
    description:
      "Start from the Forge home view and jump into the workspaces, issues, and teams that matter next.",
  },
  "/inbox": {
    eyebrow: "Queue",
    title: "Inbox",
    description:
      "Triage fresh work, recent updates, and incoming activity from one focused command center.",
  },
  "/my-issues": {
    eyebrow: "Execution",
    title: "My issues",
    description:
      "Track the issues you own, spot what needs attention next, and keep delivery moving.",
  },
  "/workspace/initiatives": {
    eyebrow: "Workspace",
    title: "Initiatives",
    description:
      "Group long-running efforts, connect outcomes to teams, and keep strategic work visible.",
  },
  "/workspace/projects": {
    eyebrow: "Workspace",
    title: "Projects",
    description:
      "Organize active project streams, deadlines, and owners in one shared operating view.",
  },
  "/workspace/calls": {
    eyebrow: "Workspace",
    title: "Calls",
    description:
      "Review the conversations that matter, with room for follow-ups, notes, and next actions.",
  },
  "/workspace/signals": {
    eyebrow: "Workspace",
    title: "Signals",
    description:
      "Surface the highest-signal events across the app so the team can react early and clearly.",
  },
  "/workspace/insights": {
    eyebrow: "Workspace",
    title: "Insights",
    description:
      "Turn raw activity into patterns, summaries, and decision-ready observations.",
  },
  "/workspace/views": {
    eyebrow: "Workspace",
    title: "Views",
    description:
      "Save and revisit the slices of work that help each team member stay oriented.",
  },
  "/workspace/teams": {
    eyebrow: "Workspace",
    title: "Teams",
    description:
      "See how work is grouped, who owns what, and where collaboration is happening.",
  },
  "/workspace/members": {
    eyebrow: "Workspace",
    title: "Members",
    description:
      "Keep a lightweight directory of collaborators, ownership, and who is participating where.",
  },
  "/agent": {
    eyebrow: "Automation",
    title: "Agent",
    description:
      "Create a home for agent-driven workflows, prompts, and the automations that support the team.",
  },
}

export function getPageMeta(pathname: string): PageMeta {
  const teamMatch = pathname.match(
    /^\/teams\/(product|engineering|operations)\/(projects|issues|signals|calls|insights)$/
  )

  if (teamMatch) {
    const [, teamSlug, teamSection] = teamMatch as [
      string,
      TeamSlug,
      TeamSection,
    ]
    const team =
      teamDefinitions.find((item) => item.slug === teamSlug)?.title ?? "Team"
    const section =
      teamSectionDefinitions.find((item) => item.section === teamSection)
        ?.title ?? "Overview"

    return {
      eyebrow: "Your teams",
      title: `${team} ${section}`,
      description: `Track ${team.toLowerCase()} ${section.toLowerCase()} in a dedicated team workspace.`,
    }
  }

  return (
    pageMetaByPath[pathname as AppPath] ?? {
      eyebrow: "Forge",
      title: "Forge",
      description:
        "A focused workspace for triage, execution, and agent-assisted delivery.",
    }
  )
}

export function getBreadcrumbItems(pathname: string): BreadcrumbItem[] {
  const teamMatch = pathname.match(
    /^\/teams\/(product|engineering|operations)\/(projects|issues|signals|calls|insights)$/
  )

  if (teamMatch) {
    const [, teamSlug, teamSection] = teamMatch as [
      string,
      TeamSlug,
      TeamSection,
    ]
    const team =
      teamDefinitions.find((item) => item.slug === teamSlug)?.title ?? "Team"
    const section =
      teamSectionDefinitions.find((item) => item.section === teamSection)
        ?.title ?? "Overview"

    return [
      { label: "Your teams", to: getTeamPath("product", "projects") },
      { label: team, to: getTeamPath(teamSlug, "projects") },
      { label: section },
    ]
  }

  const rootItem = appNav.find(
    (item) =>
      pathname === item.to ||
      item.items?.some((subItem) => pathname === subItem.to)
  )

  if (!rootItem) {
    return [{ label: "Forge" }]
  }

  const childItem = rootItem.items?.find((item) => pathname === item.to)

  if (!childItem) {
    return [{ label: rootItem.title }]
  }

  return [
    { label: rootItem.title, to: rootItem.to },
    { label: childItem.title },
  ]
}

export function isNavItemActive(
  pathname: string,
  item: Pick<AppNavItem, "to" | "items">
): boolean {
  if (pathname === item.to) {
    return true
  }

  return (
    item.items?.some(
      (subItem) =>
        pathname === subItem.to ||
        (subItem.items ? isNavItemActive(pathname, subItem) : false)
    ) ?? false
  )
}
