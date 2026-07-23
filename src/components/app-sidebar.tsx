"use client"

import * as React from "react"
import {
  AccountSetting01Icon,
  ArrowRight01Icon,
  Building02Icon,
  CrownIcon,
  Logout03Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Link, useRouter, useRouterState } from "@tanstack/react-router"

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
  DropdownMenuLabel,
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
import { listTeams } from "@/lib/team-state"
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
        | { activeOrganizationId?: string | null }
        | undefined
    )?.activeOrganizationId ?? null
  const [workspace, setWorkspace] = React.useState<WorkspaceSummary | null>(
    null
  )
  const [isWorkspaceLoading, setIsWorkspaceLoading] = React.useState(false)
  const [workspaceTeams, setWorkspaceTeams] = React.useState<
    Array<TeamSummary>
  >([])
  const primaryNav = appNav.filter(
    (item) => item.title !== "Workspace" && item.title !== "Your teams"
  )
  const workspaceSection = appNav.filter((item) => item.title === "Workspace")
  const teamsSection = appNav
    .filter((item) => item.title === "Your teams")
    .map((item) => ({
      ...item,
      items: buildYourTeamsNav(workspaceTeams),
    }))

  React.useEffect(() => {
    if (!sessionId) {
      setWorkspace(null)
      setWorkspaceTeams([])
      setIsWorkspaceLoading(false)
      return
    }

    let isCancelled = false
    setIsWorkspaceLoading(true)

    void Promise.allSettled([getNavigationAuthState(), listTeams()])
      .then(([authStateResult, teamsResult]) => {
        if (isCancelled) {
          return
        }

        setWorkspace(
          authStateResult.status === "fulfilled"
            ? authStateResult.value.workspace
            : null
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
        setWorkspaceTeams([])
        setIsWorkspaceLoading(false)
      })

    return () => {
      isCancelled = true
    }
  }, [activeOrganizationId, sessionId])

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
          className="size-4 shrink-0 object-contain"
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
                className="p-1"
              >
                <DropdownMenuGroup>
                  <DropdownMenuLabel className="px-2 py-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <Avatar className="size-4 after:hidden">
                        {workspaceLogo ? (
                          <AvatarImage
                            src={workspaceLogo}
                            alt={workspaceName}
                          />
                        ) : null}
                        <AvatarFallback>
                          {workspaceInitials(workspaceName)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm font-semibold text-foreground">
                          {workspaceName}
                        </span>
                      </div>
                    </div>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuItem
                  className="h-7 min-h-0 rounded-xl px-2 py-1 text-sm font-medium"
                  onClick={() => {
                    void router.navigate({
                      to: "/inbox",
                    })
                  }}
                >
                  <HugeiconsIcon icon={Building02Icon} strokeWidth={2} />
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
