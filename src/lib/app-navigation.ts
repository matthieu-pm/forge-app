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
  icon: AppIcon
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
  { title: "Initiatives", to: "/workspace/initiatives", icon: GitBranchIcon },
  { title: "Projects", to: "/workspace/projects", icon: FolderDetailsIcon },
  { title: "Calls", to: "/workspace/calls", icon: Call02Icon },
  { title: "Signals", to: "/workspace/signals", icon: FileSignalIcon },
  { title: "Insights", to: "/workspace/insights", icon: ChartRingIcon },
  { title: "Views", to: "/workspace/views", icon: GridViewIcon },
  { title: "Teams", to: "/workspace/teams", icon: AddTeamIcon },
  { title: "Members", to: "/workspace/members", icon: UserIcon },
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
