import type { ComponentProps } from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  AddTeamIcon,
  Call02Icon,
  ChartRingIcon,
  FileDiffIcon,
  FileSignalIcon,
  FolderDetailsIcon,
  FolderKanbanIcon,
  GitBranchIcon,
  GridViewIcon,
  InboxUnreadIcon,
  RoboticIcon,
  UserIcon,
} from "@hugeicons/core-free-icons"

type AppIcon = ComponentProps<typeof HugeiconsIcon>["icon"]

export type AppPath =
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

export type AppNavChild = {
  title: string
  to: AppPath
}

export type AppNavItem = {
  title: string
  to: AppPath
  icon: AppIcon
  items?: AppNavChild[]
}

type PageMeta = {
  eyebrow: string
  title: string
  description: string
}

export const workspaceNav: AppNavChild[] = [
  { title: "Initiatives", to: "/workspace/initiatives" },
  { title: "Projects", to: "/workspace/projects" },
  { title: "Calls", to: "/workspace/calls" },
  { title: "Signals", to: "/workspace/signals" },
  { title: "Insights", to: "/workspace/insights" },
  { title: "Views", to: "/workspace/views" },
  { title: "Teams", to: "/workspace/teams" },
  { title: "Members", to: "/workspace/members" },
]

export const appNav: AppNavItem[] = [
  {
    title: "Inbox",
    to: "/inbox",
    icon: InboxUnreadIcon,
  },
  {
    title: "My issues",
    to: "/my-issues",
    icon: FileDiffIcon,
  },
  {
    title: "Workspace",
    to: "/workspace/initiatives",
    icon: FolderKanbanIcon,
    items: workspaceNav,
  },
  {
    title: "Agent",
    to: "/agent",
    icon: RoboticIcon,
  },
]

const pageMetaByPath: Record<AppPath, PageMeta> = {
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
  return (
    pageMetaByPath[pathname as AppPath] ?? {
      eyebrow: "Forge",
      title: "Forge",
      description:
        "A focused workspace for triage, execution, and agent-assisted delivery.",
    }
  )
}

export function isNavItemActive(
  pathname: string,
  item: Pick<AppNavItem, "to" | "items">
) {
  if (pathname === item.to) {
    return true
  }

  return item.items?.some((subItem) => subItem.to === pathname) ?? false
}

export const workspaceHighlights = [
  {
    title: "Shared context",
    description:
      "Space for saved views, linked projects, and the context everyone needs.",
    icon: FolderDetailsIcon,
  },
  {
    title: "Cross-team initiatives",
    description:
      "A clear way to connect strategic bets back to project-level execution.",
    icon: GitBranchIcon,
  },
  {
    title: "Operational signals",
    description:
      "Room for calls, signals, and insights without changing the shell again later.",
    icon: FileSignalIcon,
  },
  {
    title: "Team structure",
    description:
      "Dedicated pages for teams and members so the workspace can grow cleanly.",
    icon: AddTeamIcon,
  },
  {
    title: "Views library",
    description:
      "Custom saved views can live beside the rest of the workspace primitives.",
    icon: GridViewIcon,
  },
  {
    title: "Insight stream",
    description:
      "A landing spot for analytics and summaries as the product gets richer.",
    icon: ChartRingIcon,
  },
  {
    title: "Call queue",
    description:
      "A structured area for call review, prep, and follow-up workflows.",
    icon: Call02Icon,
  },
  {
    title: "Member directory",
    description:
      "People and ownership stay visible as the workspace becomes more collaborative.",
    icon: UserIcon,
  },
]
