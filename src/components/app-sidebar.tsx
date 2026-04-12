"use client"

import * as React from "react"
import { Link, useRouter, useRouterState } from "@tanstack/react-router"
import { appNav, isNavItemActive, type AppNavChild } from "@/lib/app-navigation"
import { authClient } from "@/lib/auth-client"
import { getAuthState } from "@/lib/auth-state"
import type { WorkspaceSummary } from "@/lib/auth-types"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight01Icon } from "@hugeicons/core-free-icons"

function workspaceInitials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
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
  const [workspace, setWorkspace] = React.useState<WorkspaceSummary | null>(null)
  const [isWorkspaceLoading, setIsWorkspaceLoading] = React.useState(false)
  const primaryNav = appNav.filter(
    (item) =>
      item.title === "Forge" ||
      item.title === "Inbox" ||
      item.title === "My issues"
  )
  const workspaceSection = appNav.filter((item) => item.title === "Workspace")
  const teamsSection = appNav.filter((item) => item.title === "Your teams")

  React.useEffect(() => {
    if (!sessionId) {
      setWorkspace(null)
      setIsWorkspaceLoading(false)
      return
    }

    let isCancelled = false
    setIsWorkspaceLoading(true)

    void getAuthState()
      .then((authState) => {
        if (isCancelled) {
          return
        }

        setWorkspace(authState.workspace)
        setIsWorkspaceLoading(false)
      })
      .catch(() => {
        if (isCancelled) {
          return
        }

        setWorkspace(null)
        setIsWorkspaceLoading(false)
      })

    return () => {
      isCancelled = true
    }
  }, [activeOrganizationId, sessionId])

  async function handleSignOut() {
    await authClient.signOut()
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

  function renderItemIcon(item: Pick<AppNavChild, "icon" | "iconSrc" | "title">) {
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

  function renderNavItems(items: AppNavChild[], depth = 0) {
    const isNested = depth > 0

    return (
      <SidebarMenuSub
        className={
          isNested ? "translate-x-0 gap-0" : "mx-0 translate-x-0 border-l-0 px-0 gap-0"
        }
      >
        {items.map((item) =>
          item.items?.length ? (
            <Collapsible
              key={item.title}
              defaultOpen={isNavItemActive(pathname, item)}
              className="group/collapsible"
            >
              <SidebarMenuSubItem className="w-full">
                <SidebarMenuButton
                  className="h-7 py-1 text-sm font-medium [&>svg]:size-4"
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
                <CollapsibleContent>
                  {renderNavItems(item.items, depth + 1)}
                </CollapsibleContent>
              </SidebarMenuSubItem>
            </Collapsible>
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

  function renderRootItem(item: (typeof appNav)[number], teamsScrollable = false) {
    return item.items?.length ? (
      <Collapsible
        key={item.title}
        defaultOpen={isNavItemActive(pathname, item)}
        className={
          teamsScrollable
            ? "group/collapsible flex min-h-0 flex-1 flex-col"
            : "group/collapsible"
        }
      >
        <SidebarMenuItem
          className={teamsScrollable ? "flex min-h-0 flex-1 flex-col" : undefined}
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
          <CollapsibleContent className={teamsScrollable ? "min-h-0 flex-1" : undefined}>
            <div>{renderNavItems(item.items)}</div>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
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
  const workspaceEmail = sessionState.data?.user.email ?? ""

  return (
    <Sidebar {...props}>
      <SidebarHeader className="px-2 pt-3 pb-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <SidebarMenuButton
                className="h-7 py-1 text-xs font-medium text-foreground aria-expanded:border-black aria-expanded:bg-transparent aria-expanded:text-foreground"
                render={<DropdownMenuTrigger />}
              >
                <Avatar className="size-4 after:hidden">
                  {workspaceLogo ? (
                    <AvatarImage src={workspaceLogo} alt={workspaceName} />
                  ) : null}
                  <AvatarFallback>{workspaceInitials(workspaceName)}</AvatarFallback>
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
                className="min-w-56 rounded-none"
              >
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    <div className="flex flex-col gap-1">
                      <span className="font-medium text-foreground">
                        {workspaceName}
                      </span>
                      {workspaceEmail ? (
                        <span className="text-muted-foreground">
                          {workspaceEmail}
                        </span>
                      ) : null}
                    </div>
                  </DropdownMenuLabel>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => {
                    void router.navigate({
                      to: "/inbox",
                    })
                  }}
                >
                  Open workspace
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void handleSignOut()}>
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pb-0">
          <SidebarMenu>{primaryNav.map((item) => renderRootItem(item))}</SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="pt-4 pb-0">
          <SidebarMenu>
            {workspaceSection.map((item) => renderRootItem(item))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="flex-1 min-h-0 pt-4">
          <SidebarMenu className="flex h-full min-h-0 flex-col">
            {teamsSection.map((item) => renderRootItem(item, true))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
