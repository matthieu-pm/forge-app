"use client"

import * as React from "react"
import {
  AccountSetting01Icon,
  Add01Icon,
  ArrowRight01Icon,
  CrownIcon,
  Logout03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link, useRouter, useRouterState } from "@tanstack/react-router"
import { toast } from "sonner"

import type { AppNavChild } from "@/lib/app-navigation"
import type { WorkspaceSummary } from "@/lib/auth-types"
import type { TeamSummary } from "@/lib/team-contract"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { GettingStartedChecklist } from "@/components/getting-started-checklist"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import {
  appNav,
  buildYourTeamsNav,
  isNavItemActive,
} from "@/lib/app-navigation"
import { authClient } from "@/lib/auth-client"
import { getNavigationAuthState } from "@/lib/auth-state"
import { TEAM_LIST_CHANGED_EVENT } from "@/lib/team-events"
import { listTeams } from "@/lib/team-state"
import { useEnabledTeamCycles } from "@/lib/team-cycles"
import { getForgeHost } from "@/host/forge-host"
import { getSidebarDisclosureKey } from "@/lib/sidebar-disclosure"
import { cn } from "@/lib/utils"

function workspaceInitials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
}

function toWorkspaceSummaries(value: unknown): Array<WorkspaceSummary> {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      !("id" in candidate) ||
      !("name" in candidate) ||
      !("slug" in candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.name !== "string" ||
      typeof candidate.slug !== "string"
    ) {
      return []
    }

    return [
      {
        id: candidate.id,
        name: candidate.name,
        slug: candidate.slug,
        logo:
          "logo" in candidate && typeof candidate.logo === "string"
            ? candidate.logo
            : null,
      },
    ]
  })
}

function PersistentCollapsible({
  initiallyOpen,
  ...props
}: Omit<React.ComponentProps<typeof Collapsible>, "defaultOpen"> & {
  initiallyOpen: boolean
}) {
  const [defaultOpen] = React.useState(initiallyOpen)

  return <Collapsible defaultOpen={defaultOpen} {...props} />
}

function SidebarCollapsibleContent({
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      className={cn(
        "h-(--collapsible-panel-height) overflow-hidden transition-[height,opacity,translate] duration-200 ease-out data-ending-style:h-0 data-ending-style:-translate-y-1 data-ending-style:opacity-0 data-starting-style:h-0 data-starting-style:-translate-y-1 data-starting-style:opacity-0 motion-reduce:transition-none",
        className
      )}
      {...props}
    />
  )
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const router = useRouter()
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const sessionState = authClient.useSession()
  const sessionId = sessionState.data?.session.id ?? null
  const activeOrganizationId =
    (
      sessionState.data?.session as
        { activeOrganizationId?: string | null } | undefined
    )?.activeOrganizationId ?? null
  const [workspace, setWorkspace] = React.useState<WorkspaceSummary | null>(
    null
  )
  const [workspaces, setWorkspaces] = React.useState<Array<WorkspaceSummary>>(
    []
  )
  const [isWorkspaceLoading, setIsWorkspaceLoading] = React.useState(false)
  const [switchingWorkspaceId, setSwitchingWorkspaceId] = React.useState<
    string | null
  >(null)
  const [workspaceTeams, setWorkspaceTeams] = React.useState<
    Array<TeamSummary>
  >([])
  const enabledCycleTeams = useEnabledTeamCycles(
    workspaceTeams.map((team) => team.id)
  )
  const primaryNav = appNav.filter(
    (item) => item.title !== "Workspace" && item.title !== "Your teams"
  )
  const workspaceSection = appNav.filter((item) => item.title === "Workspace")
  const teamsSection = appNav
    .filter((item) => item.title === "Your teams")
    .map((item) => ({
      ...item,
      items: buildYourTeamsNav(
        workspaceTeams.map((team) => ({
          ...team,
          cyclesEnabled: enabledCycleTeams.has(team.id),
        }))
      ),
    }))

  React.useEffect(() => {
    if (!sessionId) {
      setWorkspace(null)
      setWorkspaces([])
      setWorkspaceTeams([])
      setIsWorkspaceLoading(false)
      return
    }

    let isCancelled = false
    setIsWorkspaceLoading(true)

    void Promise.allSettled([
      getNavigationAuthState(),
      listTeams(),
      authClient.organization.list(),
    ])
      .then(([authStateResult, teamsResult, workspacesResult]) => {
        if (isCancelled) {
          return
        }

        const activeWorkspace =
          authStateResult.status === "fulfilled"
            ? authStateResult.value.workspace
            : null
        const availableWorkspaces =
          workspacesResult.status === "fulfilled" &&
          !workspacesResult.value.error
            ? toWorkspaceSummaries(workspacesResult.value.data)
            : []

        setWorkspace(activeWorkspace)
        setWorkspaces(
          availableWorkspaces.length > 0
            ? availableWorkspaces
            : activeWorkspace
              ? [activeWorkspace]
              : []
        )
        setWorkspaceTeams(
          teamsResult.status === "fulfilled" ? teamsResult.value : []
        )
        setIsWorkspaceLoading(false)
      })
      .catch(() => {
        if (isCancelled) {
          return
        }

        setWorkspace(null)
        setWorkspaces([])
        setWorkspaceTeams([])
        setIsWorkspaceLoading(false)
      })

    return () => {
      isCancelled = true
    }
  }, [activeOrganizationId, sessionId])

  React.useEffect(() => {
    if (!sessionId) return

    let cancelled = false
    function reloadTeams() {
      void listTeams()
        .then((items) => {
          if (!cancelled) setWorkspaceTeams(items)
        })
        .catch(() => {
          if (!cancelled) setWorkspaceTeams([])
        })
    }

    window.addEventListener(TEAM_LIST_CHANGED_EVENT, reloadTeams)
    return () => {
      cancelled = true
      window.removeEventListener(TEAM_LIST_CHANGED_EVENT, reloadTeams)
    }
  }, [activeOrganizationId, sessionId])

  async function handleWorkspaceSwitch(nextWorkspace: WorkspaceSummary) {
    if (nextWorkspace.id === workspace?.id || switchingWorkspaceId !== null) {
      return
    }

    setSwitchingWorkspaceId(nextWorkspace.id)

    const { error } = await authClient.organization.setActive({
      organizationId: nextWorkspace.id,
    })

    if (error) {
      setSwitchingWorkspaceId(null)
      toast.error(error.message ?? `Could not switch to ${nextWorkspace.name}.`)
      return
    }

    window.location.assign("/inbox")
  }

  async function handleSignOut() {
    const host = getForgeHost()
    const runtime = await host.getRuntime()
    const shouldClearDesktopSession =
      runtime.capabilities.includes("browser-auth")

    await Promise.allSettled([
      authClient.signOut(),
      ...(shouldClearDesktopSession ? [host.signOut()] : []),
    ])

    await router.invalidate()
    await router.navigate({
      to: "/login",
      search: {
        redirect: undefined,
      },
    })
  }

  function renderNavLink(to: AppNavChild["to"]) {
    return <Link to={to as never} />
  }

  function renderItemIcon(
    item: Pick<AppNavChild, "icon" | "iconSrc" | "teamIcon" | "title">
  ) {
    if (item.teamIcon) {
      return <TeamSidebarIcon icon={item.teamIcon} name={item.title} />
    }

    if (item.iconSrc) {
      return (
        <img
          src={item.iconSrc}
          alt=""
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 object-contain",
            item.title === "Forge" && "-translate-x-px dark:invert"
          )}
        />
      )
    }

    if (item.icon) {
      return <HugeiconsIcon icon={item.icon} strokeWidth={2} />
    }

    return null
  }

  function renderNavItems(items: Array<AppNavChild>, depth = 0) {
    const isNested = depth > 0

    return (
      <SidebarMenuSub
        className={
          isNested
            ? "mx-0 box-border w-full translate-x-0 gap-px self-stretch border-l-0 pr-0! pl-2!"
            : "mx-0 translate-x-0 gap-px border-l-0 px-0"
        }
      >
        {items.map((item) =>
          item.items?.length ? (
            <PersistentCollapsible
              key={getSidebarDisclosureKey(
                item.title,
                isNavItemActive(pathname, item)
              )}
              initiallyOpen={isNavItemActive(pathname, item)}
              className="group/collapsible w-full"
            >
              <SidebarMenuSubItem className="w-full">
                <SidebarMenuButton
                  className="h-7 py-1 pl-2.5 text-sm font-medium [&>svg]:size-4"
                  isActive={false}
                  render={<CollapsibleTrigger />}
                >
                  {renderItemIcon(item) ?? (
                    <Avatar className="size-4 rounded-md after:rounded-md">
                      <AvatarFallback className="rounded-md text-[9px] font-semibold">
                        {workspaceInitials(item.title)}
                      </AvatarFallback>
                    </Avatar>
                  )}
                  {item.title}
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    strokeWidth={2}
                    className="ml-auto transition-transform duration-200 group-aria-expanded/menu-button:rotate-90"
                  />
                </SidebarMenuButton>
                <SidebarCollapsibleContent className="w-full">
                  {renderNavItems(item.items, depth + 1)}
                </SidebarCollapsibleContent>
              </SidebarMenuSubItem>
            </PersistentCollapsible>
          ) : (
            <SidebarMenuSubItem key={item.title} className="w-full">
              <SidebarMenuButton
                className={
                  depth > 0
                    ? "h-7 w-full py-1 pr-3 text-sm font-medium [&>svg]:size-4"
                    : "h-7 w-full py-1 text-sm font-medium [&>svg]:size-4"
                }
                isActive={pathname === item.to}
                render={renderNavLink(item.to)}
              >
                {renderItemIcon(item)}
                {item.title}
              </SidebarMenuButton>
            </SidebarMenuSubItem>
          )
        )}
      </SidebarMenuSub>
    )
  }

  function renderRootItem(
    item: (typeof appNav)[number],
    teamsScrollable = false
  ) {
    return item.items?.length ? (
      <PersistentCollapsible
        key={getSidebarDisclosureKey(
          item.title,
          isNavItemActive(pathname, item)
        )}
        initiallyOpen={isNavItemActive(pathname, item)}
        className={
          teamsScrollable
            ? "group/collapsible flex min-h-0 w-full flex-1 flex-col"
            : "group/collapsible w-full"
        }
      >
        <SidebarMenuItem
          className={
            teamsScrollable ? "flex min-h-0 flex-1 flex-col" : undefined
          }
        >
          <SidebarMenuButton
            className="h-7 py-1 text-sm font-medium text-foreground/70"
            isActive={false}
            render={<CollapsibleTrigger />}
          >
            {renderItemIcon(item)}
            {item.title}
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className="ml-auto transition-transform duration-200 group-aria-expanded/menu-button:rotate-90"
            />
          </SidebarMenuButton>
          <SidebarCollapsibleContent
            className={teamsScrollable ? "min-h-0 w-full" : "w-full"}
          >
            <div className="w-full">{renderNavItems(item.items)}</div>
          </SidebarCollapsibleContent>
        </SidebarMenuItem>
      </PersistentCollapsible>
    ) : (
      <SidebarMenuItem key={item.title}>
        <SidebarMenuButton
          className="h-7 py-1 text-sm font-medium"
          isActive={pathname === item.to}
          render={renderNavLink(item.to)}
        >
          {renderItemIcon(item)}
          {item.title}
        </SidebarMenuButton>
      </SidebarMenuItem>
    )
  }

  const workspaceName = isWorkspaceLoading
    ? "Loading workspace..."
    : workspace?.name || "Forge"
  const workspaceLogo = workspace?.logo || null

  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader className="px-2 pt-3 pb-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <SidebarMenuButton
                className="h-7 px-2 py-1 text-sm font-medium text-sidebar-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-sidebar-accent-foreground"
                render={<DropdownMenuTrigger />}
              >
                <Avatar className="size-5 after:hidden">
                  {workspaceLogo ? (
                    <AvatarImage src={workspaceLogo} alt={workspaceName} />
                  ) : null}
                  <AvatarFallback>
                    {workspaceInitials(workspaceName)}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate text-sm font-medium">
                  {workspaceName}
                </span>
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className="ml-auto transition-transform duration-200 group-aria-expanded/menu-button:rotate-90"
                />
              </SidebarMenuButton>
              <DropdownMenuContent
                align="start"
                side="bottom"
                sideOffset={8}
                className="min-w-64 p-1"
              >
                <DropdownMenuGroup>
                  {workspaces.map((availableWorkspace) => {
                    const isActive = availableWorkspace.id === workspace?.id
                    const isSwitching =
                      availableWorkspace.id === switchingWorkspaceId

                    return (
                      <DropdownMenuItem
                        key={availableWorkspace.id}
                        className="h-7 min-h-0 rounded-xl px-2 py-1 text-sm"
                        disabled={switchingWorkspaceId !== null}
                        aria-current={isActive ? "true" : undefined}
                        onClick={() =>
                          void handleWorkspaceSwitch(availableWorkspace)
                        }
                      >
                        <Avatar className="size-4 after:hidden">
                          {availableWorkspace.logo ? (
                            <AvatarImage src={availableWorkspace.logo} alt="" />
                          ) : null}
                          <AvatarFallback className="text-[9px] font-semibold">
                            {workspaceInitials(availableWorkspace.name)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {availableWorkspace.name}
                        </span>
                        {isActive || isSwitching ? (
                          <HugeiconsIcon
                            icon={Tick02Icon}
                            strokeWidth={2}
                            className="text-muted-foreground"
                          />
                        ) : null}
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="h-7 min-h-0 rounded-xl px-2 py-1 text-sm font-medium"
                  render={<Link to="/onboarding/workspace" />}
                >
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                  New workspace
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="h-7 min-h-0 rounded-xl px-2 py-1 text-sm font-medium"
                  render={<Link to="/settings" />}
                >
                  <HugeiconsIcon icon={AccountSetting01Icon} strokeWidth={2} />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="h-7 min-h-0 rounded-xl px-2 py-1 text-sm font-medium"
                  render={<a href="#upgrade-plan" />}
                >
                  <HugeiconsIcon icon={CrownIcon} strokeWidth={2} />
                  Upgrade plan
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="h-7 min-h-0 rounded-xl px-2 py-1 text-sm font-medium"
                  onClick={() => void handleSignOut()}
                >
                  <HugeiconsIcon icon={Logout03Icon} strokeWidth={2} />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pb-0">
          <SidebarMenu className="gap-px">
            {primaryNav.map((item) => renderRootItem(item))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="pt-4 pb-0">
          <SidebarMenu>
            {workspaceSection.map((item) => renderRootItem(item))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="min-h-0 flex-1 pt-4">
          <SidebarMenu className="flex h-full min-h-0 flex-col">
            {teamsSection.map((item) => renderRootItem(item, true))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="px-2 pt-1 pb-0">
        <GettingStartedChecklist />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
