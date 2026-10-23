import {
  AirplayLineIcon,
  Asteroid02Icon,
  Call02Icon,
  CenterFocusIcon,
  ClipboardIcon,
  Clock05Icon,
  CodepenIcon,
  CubeIcon,
  GitPullRequestArrowIcon,
  Home01Icon,
  InboxUnreadIcon,
  LayerIcon,
  UserGroup03Icon,
  UserIdVerificationIcon,
} from "@hugeicons/core-free-icons"
import type { HugeiconsIcon } from "@hugeicons/react"
import type { ComponentProps } from "react"
import type { TeamSummary } from "@/lib/team-contract"

type AppIcon = ComponentProps<typeof HugeiconsIcon>["icon"]
type TeamSlug = string
type TeamSection =
  | "overview"
  | "documents"
  | "loops"
  | "members"
  | "projects"
  | "views"
  | "issues"
  | "triage"
  | "cycles"
  | "signals"
  | "calls"
  | "insights"
type TeamPath = `/teams/${TeamSlug}/${TeamSection}`

export type AppPath =
  | "/forge"
  | "/settings"
  | "/settings/profile"
  | "/settings/issue-labels"
  | "/settings/project-statuses"
  | "/settings/project-updates"
  | "/settings/notifications"
  | "/settings/account/security"
  | "/settings/account/connections"
  | "/settings/account/agents"
  | "/settings/code-and-reviews"
  | "/settings/calls-and-transcripts"
  | "/settings/api"
  | "/settings/ai"
  | "/settings/emojis"
  | "/settings/integrations"
  | "/settings/applications"
  | "/settings/billing"
  | "/settings/import-export"
  | "/settings/members"
  | "/settings/security"
  | "/settings/sla"
  | "/settings/teams"
  | "/settings/workspace"
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
  | `/teams/${string}/cycle/upcoming`
  | `/teams/${string}/cycle/${number}`

export type AppNavChild = {
  title: string
  to: AppPath
  icon?: AppIcon
  iconSrc?: string
  teamIcon?: TeamSummary["icon"]
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
  { title: "Home", section: "overview", icon: Home01Icon },
  { title: "Triage", section: "triage", icon: InboxUnreadIcon },
  { title: "Issues", section: "issues", icon: ClipboardIcon },
  { title: "Cycles", section: "cycles", icon: Clock05Icon },
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
  teams: ReadonlyArray<{
    name: string
    slug: string
    icon?: TeamSummary["icon"]
    cyclesEnabled?: boolean
    triageEnabled?: boolean
  }>
): Array<AppNavChild> {
  return teams.map((team) => ({
    title: team.name,
    to: getTeamPath(team.slug, "overview"),
    teamIcon: team.icon,
    items: teamSectionDefinitions
      .filter(
        (section) =>
          section.section === "overview" ||
          section.section === "projects" ||
          section.section === "views" ||
          (section.section === "cycles" && team.cyclesEnabled === true) ||
          (section.section === "triage" && team.triageEnabled === true) ||
          section.section === "issues"
      )
      .map((section) => ({
        title: section.title,
        to: getTeamPath(team.slug, section.section),
        icon: section.icon,
        ...(section.section === "cycles"
          ? {
              items: [
                {
                  title: "Upcoming",
                  to: `/teams/${team.slug}/cycle/upcoming` as AppPath,
                },
              ],
            }
          : {}),
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
    iconSrc: "/img/forge-logo-black.svg",
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
  "/settings/ai": {
    eyebrow: "Agent runtime",
    title: "AI & Agents",
    description: "Manage model providers and local agent runtimes.",
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
    /^\/teams\/([^/]+)\/(projects|views|issues|triage|cycles|signals|calls|insights)$/
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
  const homeMatch =
    /^\/teams\/([^/]+)\/(overview|documents|loops|members)$/.exec(pathname)
  if (homeMatch)
    return [
      {
        label:
          homeMatch[2] === "overview"
            ? teamTitleFromSlug(homeMatch[1])
            : homeMatch[2][0].toUpperCase() + homeMatch[2].slice(1),
      },
    ]
  const recurringMatch =
    /^\/settings\/teams\/[^/]+\/recurring-issues(?:\/([^/]+))?\/?$/.exec(
      pathname
    )
  if (recurringMatch)
    return [
      {
        label: recurringMatch[1]
          ? `${recurringMatch[1] === "new" ? "New" : "Edit"} recurring issue`
          : "Recurring issues",
      },
    ]
  if (pathname === "/settings/initiatives") return [{ label: "Initiatives" }]
  if (pathname === "/settings/initiative-labels")
    return [{ label: "Initiative labels" }]
  if (pathname === "/settings/project-labels")
    return [{ label: "Project labels" }]

  if (pathname === "/settings/project-updates") return [{ label: "Updates" }]

  if (pathname === "/settings/project-templates")
    return [{ label: "Project templates" }]

  if (pathname === "/settings/issue-templates")
    return [{ label: "Issue templates" }]
  const workspaceTemplateMatch =
    /^\/settings\/templates\/(issue|project)\/([^/]+)$/.exec(pathname)
  if (workspaceTemplateMatch)
    return [
      {
        label: `${workspaceTemplateMatch[2] === "new" ? "New" : "Edit"} ${workspaceTemplateMatch[1]} template`,
      },
    ]

  const templateMatch =
    /^\/settings\/teams\/[^/]+\/templates(?:\/(issue|project|document)\/([^/]+))?\/?$/.exec(
      pathname
    )
  if (templateMatch)
    return [
      {
        label: templateMatch[1]
          ? `${templateMatch[2] === "new" ? "New" : "Edit"} ${templateMatch[1]} template`
          : "Templates",
      },
    ]

  if (/^\/settings\/teams\/[^/]+\/members$/.test(pathname)) {
    return [{ label: "Team members" }]
  }

  if (/^\/settings\/teams\/[^/]+\/labels$/.test(pathname)) {
    return [{ label: "Issue labels" }]
  }

  if (/^\/settings\/teams\/[^/]+\/ai\/updates$/.test(pathname)) {
    return [{ label: "Project updates" }]
  }

  if (/^\/settings\/teams\/[^/]+\/ai\/summaries$/.test(pathname)) {
    return [{ label: "Resolved thread summaries" }]
  }

  const skillMatch = pathname.match(
    /^\/settings\/teams\/[^/]+\/agent-skills(?:\/([^/]+))?\/?$/
  )
  if (skillMatch) {
    return [
      {
        label: skillMatch[1]
          ? skillMatch[1] === "new"
            ? "New skill"
            : "Edit skill"
          : "Agent skills",
      },
    ]
  }

  if (/^\/settings\/teams\/[^/]+\/agents$/.test(pathname)) {
    return [{ label: "Team agents" }]
  }

  if (/^\/settings\/teams\/[^/]+\/cycles$/.test(pathname)) {
    return [{ label: "Cycles" }]
  }

  if (/^\/settings\/teams\/[^/]+\/triage$/.test(pathname)) {
    return [{ label: "Triage" }]
  }

  if (/^\/settings\/teams\/[^/]+\/workflows$/.test(pathname)) {
    return [{ label: "Workflows & automations" }]
  }

  if (/^\/settings\/teams\/[^/]+\/statuses$/.test(pathname)) {
    return [{ label: "Issue statuses" }]
  }

  if (pathname === "/settings/teams") {
    return [{ label: "Teams" }]
  }

  if (pathname === "/settings/teams/new") {
    return [{ label: "Create a new team" }]
  }

  if (/^\/settings\/teams\/[^/]+$/.test(pathname)) {
    return [{ label: "Overview" }]
  }

  if (/^\/settings\/teams\/[^/]+\/general$/.test(pathname)) {
    return [{ label: "General" }]
  }

  if (pathname === "/settings") {
    return [{ label: "Preferences" }]
  }

  if (
    pathname === "/settings/notifications" ||
    pathname.startsWith("/settings/notifications/")
  ) {
    const channel = pathname.split("/")[3]
    const titles: Record<string, string> = {
      priority: "Priority notifications",
      desktop: "Desktop notifications",
      mobile: "Mobile notifications",
      email: "Email notifications",
      slack: "Slack notifications",
    }
    return [{ label: titles[channel] ?? "Notifications" }]
  }

  if (pathname === "/settings/code-and-reviews") {
    return [{ label: "Code & reviews" }]
  }
  if (pathname === "/settings/calls-and-transcripts") {
    return [{ label: "Calls and transcripts" }]
  }

  if (pathname === "/settings/emojis") {
    return [{ label: "Emojis", to: "/settings/emojis" }]
  }

  if (pathname === "/settings/integrations") {
    return [{ label: "Integrations" }]
  }

  if (pathname === "/settings/issue-labels") return [{ label: "Issue labels" }]

  if (pathname === "/settings/project-statuses") return [{ label: "Statuses" }]

  if (pathname === "/settings/sla") return [{ label: "SLAs" }]

  if (pathname === "/settings/profile") {
    return [{ label: "Profile" }]
  }

  if (pathname === "/settings/account/security") {
    return [{ label: "Security & access" }]
  }

  if (pathname === "/settings/account/connections") {
    return [{ label: "Connected accounts" }]
  }

  if (pathname === "/settings/account/agents") {
    return [{ label: "Agent personalization" }]
  }

  if (pathname === "/settings/api") {
    return [{ label: "API" }]
  }

  if (pathname === "/settings/ai") {
    return [{ label: "AI & Agents" }]
  }

  if (pathname === "/settings/security") {
    return [{ label: "Security" }]
  }

  if (pathname === "/settings/billing") {
    return [{ label: "Billing" }]
  }

  if (pathname === "/settings/applications") {
    return [{ label: "Applications" }]
  }

  if (pathname === "/settings/members") {
    return [{ label: "Members" }]
  }

  if (pathname === "/settings/workspace") {
    return [{ label: "Workspace" }]
  }

  if (pathname === "/settings/import-export") {
    return [{ label: "Import & export" }]
  }

  const upcomingCycleMatch = pathname.match(
    /^\/teams\/([^/]+)\/cycle\/(upcoming|[1-9]\d*)$/
  )
  if (upcomingCycleMatch) {
    const slug = upcomingCycleMatch[1]
    return [
      { label: teamTitleFromSlug(slug), to: getTeamPath(slug, "projects") },
      { label: "Cycles", to: getTeamPath(slug, "cycles") },
      {
        label: `Cycle ${upcomingCycleMatch[2] === "upcoming" ? 1 : upcomingCycleMatch[2]}`,
      },
    ]
  }

  const initiativeMatch = pathname.match(/^\/workspace\/initiatives\/([^/]+)$/)

  if (initiativeMatch) {
    return [
      { label: "Initiatives", to: "/workspace/initiatives" },
      { label: "Initiative" },
    ]
  }

  const teamMatch = pathname.match(
    /^\/teams\/([^/]+)\/(projects|views|issues|triage|cycles|signals|calls|insights)$/
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
  if (
    item.to.endsWith("/overview") &&
    ["overview", "documents", "loops", "members"].some(
      (section) => pathname === item.to.replace(/overview$/, section)
    )
  )
    return true

  if (pathname === item.to) {
    return true
  }

  return (
    item.items?.some(
      (subItem) =>
        isNavItemActive(pathname, { to: subItem.to }) ||
        (subItem.items ? isNavItemActive(pathname, subItem) : false)
    ) ?? false
  )
}
