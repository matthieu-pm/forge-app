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

type SettingsIcon = ComponentProps<typeof HugeiconsIcon>["icon"]

type SettingsItem = {
  label: string
  icon: SettingsIcon
  active?: boolean
}

type SettingsGroup = {
  label: string
  items: Array<SettingsItem>
}

const settingsGroups: Array<SettingsGroup> = [
  {
    label: "Personal",
    items: [
      { label: "Preferences", icon: CustomizeIcon, active: true },
      { label: "Profile", icon: AccountSetting02Icon },
      { label: "Notifications", icon: NotificationSquareIcon },
      { label: "Code and reviews", icon: ComputerTerminal01Icon },
      { label: "Security and access", icon: Key01Icon },
      { label: "Connected accounts", icon: ChipIcon },
      { label: "Agent personalization", icon: Cursor02Icon },
      { label: "Calls and transcripts", icon: Call02Icon },
    ],
  },
  {
    label: "Issues",
    items: [
      { label: "Labels", icon: Tag01Icon },
      { label: "Templates", icon: FilePasteIcon },
      { label: "SLAs", icon: Fire03Icon },
    ],
  },
  {
    label: "Projects",
    items: [
      { label: "Labels", icon: Tag01Icon },
      { label: "Templates", icon: FilePasteIcon },
      { label: "Statuses", icon: Progress03Icon },
      { label: "Updates", icon: SquareActivity },
    ],
  },
  {
    label: "Features",
    items: [
      { label: "AI & Agents", icon: FlashIcon },
      { label: "Signals", icon: Asteroid02Icon },
      { label: "Initiatives", icon: AirplayIcon },
      { label: "Emojis", icon: Monocle01Icon },
      { label: "Integrations", icon: MenuSquareIcon },
    ],
  },
  {
    label: "Administration",
    items: [
      { label: "Workspace", icon: Building02Icon },
      { label: "Teams", icon: IdentificationIcon },
      { label: "Members", icon: UserGroup03Icon },
      { label: "Security", icon: SecurityLockIcon },
      { label: "API", icon: SourceCodeIcon },
      { label: "Applications", icon: WebProgrammingIcon },
      { label: "Billing", icon: CreditCardIcon },
      { label: "Import & Export", icon: ArrowLeftRightIcon },
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

    void listTeams()
      .then((items) => {
        if (!cancelled) {
          setTeams(items)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTeams([])
        }
      })

    return () => {
      cancelled = true
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
                    type="button"
                    isActive={pathname === "/settings" && item.active}
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
                    type="button"
                    className="h-7 rounded-lg px-2 text-sm font-medium"
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
