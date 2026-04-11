"use client"

import * as React from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { appNav, isNavItemActive, type AppNavChild } from "@/lib/app-navigation"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
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

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  function renderNavLink(to: AppNavChild["to"]) {
    return to.startsWith("/teams/") ? (
      <a href={to} />
    ) : (
      <Link to={to as never} />
    )
  }

  function renderNavItems(items: AppNavChild[], depth = 0) {
    const isNested = depth > 0

    return (
      <SidebarMenuSub
        className={
          isNested ? "gap-0.5" : undefined
        }
      >
        {items.map((item) =>
          item.items?.length ? (
            <Collapsible
              key={item.title}
              defaultOpen={isNavItemActive(pathname, item)}
              className="group/collapsible"
            >
              <SidebarMenuSubItem>
                <SidebarMenuButton
                  className="h-7 py-1 text-sm font-medium text-foreground/55 [&>svg]:size-4"
                  isActive={false}
                  render={<CollapsibleTrigger />}
                >
                  {item.icon ? (
                    <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                  ) : null}
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
            <SidebarMenuSubItem key={item.title}>
              <SidebarMenuButton
                className="h-7 max-w-[calc(100%-0.75rem)] py-1 text-sm font-medium [&>svg]:size-4"
                isActive={pathname === item.to}
                render={renderNavLink(item.to)}
              >
                {item.icon ? (
                  <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                ) : null}
                {item.title}
              </SidebarMenuButton>
            </SidebarMenuSubItem>
          )
        )}
      </SidebarMenuSub>
    )
  }

  return (
    <Sidebar {...props}>
      <SidebarHeader className="px-2 pt-3 pb-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="h-7 py-0"
              render={<Link to="/inbox" />}
            >
              <div className="flex items-center gap-2 leading-none">
                <img
                  src="/img/Logo%20Forge.png"
                  alt="Forge"
                  className="size-4 object-contain"
                />
                <span className="text-base font-semibold">Forge</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="flex-1 min-h-0">
          <SidebarMenu className="flex h-full min-h-0 flex-col">
            {appNav.map((item) =>
              item.items?.length ? (
                <Collapsible
                  key={item.title}
                  defaultOpen={isNavItemActive(pathname, item)}
                  className={
                    item.title === "Your teams"
                      ? "group/collapsible flex min-h-0 flex-1 flex-col"
                      : "group/collapsible"
                  }
                >
                  <SidebarMenuItem
                    className={
                      item.title === "Your teams"
                        ? "flex min-h-0 flex-1 flex-col"
                        : undefined
                    }
                  >
                    <SidebarMenuButton
                      className="h-7 py-1 text-sm font-medium text-foreground/55"
                      isActive={false}
                      render={<CollapsibleTrigger />}
                    >
                      {item.icon ? (
                        <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                      ) : null}
                      {item.title}
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        strokeWidth={2}
                        className="ml-auto transition-transform duration-200 group-aria-expanded/menu-button:rotate-90"
                      />
                    </SidebarMenuButton>
                    <CollapsibleContent
                      className={
                        item.title === "Your teams" ? "min-h-0 flex-1" : undefined
                      }
                    >
                      <div
                        className={
                          item.title === "Your teams"
                            ? "h-full min-h-0 overflow-y-auto pr-[1px]"
                            : undefined
                        }
                      >
                        {renderNavItems(item.items)}
                      </div>
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
                    {item.icon ? (
                      <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                    ) : null}
                    {item.title}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
