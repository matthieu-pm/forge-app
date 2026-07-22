import {
  AirplayLineIcon,
  Asteroid02Icon,
  Call02Icon,
  CenterFocusIcon,
  ClipboardIcon,
  CodepenIcon,
  CubeIcon,
  GitPullRequestArrowIcon,
  InboxUnreadIcon,
  LayerIcon,
  UserGroup03Icon,
  UserIdVerificationIcon,
} from "@hugeicons/core-free-icons"
import type { HugeiconsIcon } from "@hugeicons/react"
import type { ComponentProps } from "react"

type AppIcon = ComponentProps<typeof HugeiconsIcon>["icon"]
type TeamSlug = string
type TeamSection =
  | "projects"
  | "views"
  | "issues"
  | "signals"
  | "calls"
  | "insights"
type TeamPath = `/teams/${TeamSlug}/${TeamSection}`

export type AppPath =
  | "/forge"
  | "/settings"
  | "/inbox"
  | "/my-issues"
  | "/workspace/initiatives"
  | "/workspace/initiatives/$initiativeId"
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
  items?: Array<AppNavChild>
}

export type AppNavItem = {
  title: string
  to: AppPath
  icon?: AppIcon
  iconSrc?: string
  items?: Array<AppNavChild>
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

const teamSectionDefinitions = [
  { title: "Issues", section: "issues", icon: ClipboardIcon },
  { title: "Projects", section: "projects", icon: CubeIcon },
  { title: "Views", section: "views", icon: LayerIcon },
  { title: "Signals", section: "signals", icon: Asteroid02Icon },
  { title: "Calls", section: "calls", icon: Call02Icon },
  { title: "Insights", section: "insights", icon: CodepenIcon },
] as const

function getTeamPath(slug: TeamSlug, section: TeamSection): TeamPath {
  return `/teams/${slug}/${section}`
}

export const workspaceNav: Array<AppNavChild> = [
  {
    title: "Initiatives",
    to: "/workspace/initiatives",
    icon: AirplayLineIcon,
  },
  { title: "Projects", to: "/workspace/projects", icon: CubeIcon },
  { title: "Views", to: "/workspace/views", icon: LayerIcon },
  { title: "Teams", to: "/workspace/teams", icon: UserIdVerificationIcon },
  { title: "Members", to: "/workspace/members", icon: UserGroup03Icon },
]

export function buildYourTeamsNav(
  teams: ReadonlyArray<{ name: string; slug: string }>
): Array<AppNavChild> {
  return teams.map((team) => ({
    title: team.name,
    to: getTeamPath(team.slug, "projects"),
    items: teamSectionDefinitions
      .filter(
        (section) =>
          section.section === "projects" ||
          section.section === "views" ||
          section.section === "issues"
      )
      .map((section) => ({
        title: section.title,
        to: getTeamPath(team.slug, section.section),
        icon: section.icon,
      })),
  }))
}

export const yourTeamsNav: Array<AppNavChild> = []

export const appNav: Array<AppNavItem> = [
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
    title: "Calls",
    to: "/workspace/calls",
    icon: Call02Icon,
  },
  {
    title: "Signals",
    to: "/workspace/signals",
    icon: Asteroid02Icon,
  },
  {
    title: "Reviews",
    to: "/workspace/insights",
    icon: GitPullRequestArrowIcon,
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
    to: "/workspace/teams",
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
    title: "Reviews",
    description:
      "Review proposed changes, coordinate feedback, and keep approvals moving.",
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
    /^\/teams\/([^/]+)\/(projects|views|issues|signals|calls|insights)$/
  )

  if (teamMatch) {
    const [, teamSlug, teamSection] = teamMatch as [
      string,
      TeamSlug,
      TeamSection,
    ]
    const team = teamTitleFromSlug(teamSlug)
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

export function getBreadcrumbItems(pathname: string): Array<BreadcrumbItem> {
  if (pathname === "/settings/teams/new") {
    return [{ label: "Create a new team" }]
  }

  if (pathname === "/settings") {
    return [{ label: "Preferences" }]
  }

  const initiativeMatch = pathname.match(/^\/workspace\/initiatives\/([^/]+)$/)

  if (initiativeMatch) {
    return [
      { label: "Initiatives", to: "/workspace/initiatives" },
      { label: "Initiative" },
    ]
  }

  const teamMatch = pathname.match(
    /^\/teams\/([^/]+)\/(projects|views|issues|signals|calls|insights)$/
  )

  if (teamMatch) {
    const [, teamSlug, teamSection] = teamMatch as [
      string,
      TeamSlug,
      TeamSection,
    ]
    const team = teamTitleFromSlug(teamSlug)
    const section =
      teamSectionDefinitions.find((item) => item.section === teamSection)
        ?.title ?? "Overview"

    return [
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

  return [{ label: childItem.title }]
}

function teamTitleFromSlug(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
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
