"use client"

import * as React from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { SearchForm } from "@/components/search-form"
import { appNav, isNavItemActive } from "@/lib/app-navigation"
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
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { HugeiconsIcon } from "@hugeicons/react"
import { ArrowRight01Icon, LayoutBottomIcon } from "@hugeicons/core-free-icons"

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  return (
    <Sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/inbox" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <HugeiconsIcon
                  icon={LayoutBottomIcon}
                  strokeWidth={2}
                  className="size-4"
                />
              </div>
              <div className="leading-none">
                <span className="text-base font-semibold">Forge</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SearchForm />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {appNav.map((item) =>
              item.items?.length ? (
                <Collapsible
                  key={item.title}
                  defaultOpen={isNavItemActive(pathname, item)}
                  className="group/collapsible"
                >
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      className="text-sm font-medium"
                      isActive={isNavItemActive(pathname, item)}
                      render={<CollapsibleTrigger />}
                    >
                      <HugeiconsIcon icon={item.icon} strokeWidth={2} />
                      {item.title}
                      <HugeiconsIcon
                        icon={ArrowRight01Icon}
                        strokeWidth={2}
                        className="ml-auto transition-transform duration-200 group-aria-expanded/menu-button:rotate-90"
                      />
                    </SidebarMenuButton>
                    <CollapsibleContent>
                      <SidebarMenuSub>
                        {item.items.map((subItem) => (
                          <SidebarMenuSubItem key={subItem.title}>
                            <SidebarMenuSubButton
                              className="text-sm"
                              isActive={pathname === subItem.to}
                              render={<Link to={subItem.to} />}
                            >
                              <HugeiconsIcon
                                icon={subItem.icon}
                                strokeWidth={2}
                              />
                              {subItem.title}
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      </SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuItem>
                </Collapsible>
              ) : (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton
                    className="text-sm font-medium"
                    isActive={pathname === item.to}
                    render={<Link to={item.to} />}
                  >
                    <HugeiconsIcon icon={item.icon} strokeWidth={2} />
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
