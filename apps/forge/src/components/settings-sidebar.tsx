"use client"

import * as React from "react"
import {
  AccountSetting02Icon,
  Add01Icon,
  AirplayIcon,
  ArrowLeft01Icon,
  ArrowLeftRightIcon,
  Asteroid02Icon,
  Building02Icon,
  Call02Icon,
  ChipIcon,
  ComputerTerminal01Icon,
  CreditCardIcon,
  Cursor02Icon,
  CustomizeIcon,
  FilePasteIcon,
  Fire03Icon,
  FlashIcon,
  IdentificationIcon,
  Key01Icon,
  MenuSquareIcon,
  Monocle01Icon,
  NotificationSquareIcon,
  Progress03Icon,
  Search01Icon,
  SecurityLockIcon,
  SourceCodeIcon,
  SquareActivity,
  Tag01Icon,
  UserGroup03Icon,
  WebProgrammingIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link, useRouterState } from "@tanstack/react-router"
import type { ComponentProps } from "react"
import type { TeamSummary } from "@/lib/team-contract"

import { Input } from "@/components/ui/input"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { listTeams } from "@/lib/team-state"
import { TEAM_LIST_CHANGED_EVENT } from "@/lib/team-events"

type SettingsIcon = ComponentProps<typeof HugeiconsIcon>["icon"]

type SettingsItem = {
  label: string
  icon: SettingsIcon
  active?: boolean
  to?:
    | "/settings"
    | "/settings/profile"
    | "/settings/issue-labels"
    | "/settings/project-labels"
    | "/settings/initiatives"
    | "/settings/project-statuses"
    | "/settings/project-updates"
    | "/settings/issue-templates"
    | "/settings/project-templates"
    | "/settings/account/security"
    | "/settings/account/connections"
    | "/settings/account/agents"
    | "/settings/code-and-reviews"
    | "/settings/calls-and-transcripts"
    | "/settings/signals"
    | "/settings/notifications"
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
}

type SettingsGroup = {
  label: string
  items: Array<SettingsItem>
}

const settingsGroups: Array<SettingsGroup> = [
  {
    label: "Personal",
    items: [
      {
        label: "Preferences",
        icon: CustomizeIcon,
        active: true,
        to: "/settings",
      },
      {
        label: "Profile",
        icon: AccountSetting02Icon,
        to: "/settings/profile",
      },
      {
        label: "Notifications",
        icon: NotificationSquareIcon,
        to: "/settings/notifications",
      },
      {
        label: "Code & reviews",
        icon: ComputerTerminal01Icon,
        to: "/settings/code-and-reviews",
      },
      {
        label: "Security & access",
        icon: Key01Icon,
        to: "/settings/account/security",
      },
      {
        label: "Connected accounts",
        icon: ChipIcon,
        to: "/settings/account/connections",
      },
      {
        label: "Agent personalization",
        icon: Cursor02Icon,
        to: "/settings/account/agents",
      },
      {
        label: "Calls and transcripts",
        icon: Call02Icon,
        to: "/settings/calls-and-transcripts",
      },
    ],
  },
  {
    label: "Issues",
    items: [
      { label: "Labels", icon: Tag01Icon, to: "/settings/issue-labels" },
      {
        label: "Templates",
        icon: FilePasteIcon,
        to: "/settings/issue-templates",
      },
      { label: "SLAs", icon: Fire03Icon, to: "/settings/sla" },
    ],
  },
  {
    label: "Projects",
    items: [
      { label: "Labels", icon: Tag01Icon, to: "/settings/project-labels" },
      {
        label: "Templates",
        icon: FilePasteIcon,
        to: "/settings/project-templates",
      },
      {
        label: "Statuses",
        icon: Progress03Icon,
        to: "/settings/project-statuses",
      },
      {
        label: "Updates",
        icon: SquareActivity,
        to: "/settings/project-updates",
      },
    ],
  },
  {
    label: "Features",
    items: [
      { label: "AI & Agents", icon: FlashIcon, to: "/settings/ai" },
      { label: "Signals", icon: Asteroid02Icon, to: "/settings/signals" },
      { label: "Initiatives", icon: AirplayIcon, to: "/settings/initiatives" },
      { label: "Emojis", icon: Monocle01Icon, to: "/settings/emojis" },
      {
        label: "Integrations",
        icon: MenuSquareIcon,
        to: "/settings/integrations",
      },
    ],
  },
  {
    label: "Administration",
    items: [
      {
        label: "Workspace",
        icon: Building02Icon,
        to: "/settings/workspace",
      },
      {
        label: "Teams",
        icon: IdentificationIcon,
        to: "/settings/teams",
      },
      {
        label: "Members",
        icon: UserGroup03Icon,
        to: "/settings/members",
      },
      {
        label: "Security",
        icon: SecurityLockIcon,
        to: "/settings/security",
      },
      { label: "API", icon: SourceCodeIcon, to: "/settings/api" },
      {
        label: "Applications",
        icon: WebProgrammingIcon,
        to: "/settings/applications",
      },
      {
        label: "Billing",
        icon: CreditCardIcon,
        to: "/settings/billing",
      },
      {
        label: "Import & Export",
        icon: ArrowLeftRightIcon,
        to: "/settings/import-export",
      },
    ],
  },
]

export function SettingsSidebar() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const [query, setQuery] = React.useState("")
  const [teams, setTeams] = React.useState<Array<TeamSummary>>([])

  React.useEffect(() => {
    let cancelled = false

    function loadWorkspaceTeams() {
      void listTeams()
        .then((items) => {
          if (!cancelled) setTeams(items)
        })
        .catch(() => {
          if (!cancelled) setTeams([])
        })
    }

    loadWorkspaceTeams()
    window.addEventListener(TEAM_LIST_CHANGED_EVENT, loadWorkspaceTeams)

    return () => {
      cancelled = true
      window.removeEventListener(TEAM_LIST_CHANGED_EVENT, loadWorkspaceTeams)
    }
  }, [])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleGroups = settingsGroups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) =>
        item.label.toLocaleLowerCase().includes(normalizedQuery)
      ),
    }))
    .filter((group) => group.items.length > 0)
  const visibleTeams = teams.filter((team) =>
    team.name.toLocaleLowerCase().includes(normalizedQuery)
  )

  return (
    <Sidebar variant="inset" aria-label="Settings navigation">
      <SidebarHeader className="gap-2 px-2 pt-3 pb-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="h-7 text-sm font-medium text-sidebar-foreground/70"
              render={<Link to="/inbox" />}
            >
              <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
              Back to app
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="relative">
          <HugeiconsIcon
            icon={Search01Icon}
            strokeWidth={2}
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Search settings"
            placeholder="Search settings..."
            className="h-7 rounded-lg border-0 bg-sidebar-accent pr-2 pl-8 text-sm shadow-none focus-visible:ring-2"
          />
        </div>
      </SidebarHeader>

      <SidebarContent className="gap-0 pb-3">
        {visibleGroups.map((group) => (
          <SidebarGroup key={group.label} className="gap-0 px-2 py-1.5">
            <SidebarGroupLabel className="h-7 px-2 text-sm font-medium text-sidebar-foreground/50">
              {group.label}
            </SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={`${group.label}-${item.label}`}>
                  <SidebarMenuButton
                    type={item.to ? undefined : "button"}
                    render={item.to ? <Link to={item.to} /> : undefined}
                    isActive={
                      item.to
                        ? pathname === item.to ||
                          (item.to === "/settings/issue-templates" &&
                            pathname.startsWith(
                              "/settings/templates/issue/"
                            )) ||
                          (item.to === "/settings/project-templates" &&
                            pathname.startsWith(
                              "/settings/templates/project/"
                            )) ||
                          (item.to === "/settings/initiatives" &&
                            pathname === "/settings/initiative-labels") ||
                          (item.to === "/settings/notifications" &&
                            pathname.startsWith(`${item.to}/`))
                        : pathname === "/settings" && item.active
                    }
                    className="h-7 rounded-lg px-2 text-sm font-medium [&>svg]:size-4"
                  >
                    <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}

        {visibleTeams.length > 0 || !normalizedQuery ? (
          <SidebarGroup className="gap-0 px-2 py-1.5">
            <SidebarGroupLabel className="h-7 px-2 text-sm font-medium text-sidebar-foreground/50">
              Your teams
            </SidebarGroupLabel>
            <SidebarMenu>
              {visibleTeams.map((team) => (
                <SidebarMenuItem key={team.name}>
                  <SidebarMenuButton
                    isActive={
                      pathname === `/settings/teams/${team.slug}` ||
                      pathname.startsWith(`/settings/teams/${team.slug}/`)
                    }
                    className="h-7 rounded-lg px-2 text-sm font-medium"
                    render={
                      <Link
                        to="/settings/teams/$teamSlug"
                        params={{ teamSlug: team.slug }}
                      />
                    }
                  >
                    <TeamSidebarIcon icon={team.icon} name={team.name} />
                    <span>{team.name}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              {!normalizedQuery ? (
                <SidebarMenuItem>
                  <SidebarMenuButton
                    type="button"
                    isActive={pathname === "/settings/teams/new"}
                    className="h-7 rounded-lg px-2 text-sm font-medium text-sidebar-foreground/70 [&>svg]:size-4"
                    render={<Link to="/settings/teams/new" />}
                  >
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      <HugeiconsIcon
                        icon={Add01Icon}
                        strokeWidth={2}
                        className="size-4"
                      />
                    </span>
                    <span>Create a team</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ) : null}
            </SidebarMenu>
          </SidebarGroup>
        ) : null}

        {visibleGroups.length === 0 && visibleTeams.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No settings found
          </p>
        ) : null}
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
