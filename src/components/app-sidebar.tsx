"use client"

import type { ComponentProps } from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import { NavMain } from "@/components/nav-main"
import { appNav } from "@/lib/app-navigation"
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { HugeiconsIcon } from "@hugeicons/react"
import { CommandIcon } from "@hugeicons/core-free-icons"

export function AppSidebar({ ...props }: ComponentProps<typeof Sidebar>) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  return (
    <Sidebar collapsible="icon" variant="inset" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={pathname === "/inbox"}
              size="lg"
              render={<Link to="/inbox" />}
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <HugeiconsIcon icon={CommandIcon} strokeWidth={2} />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">Forge</span>
                <span className="truncate text-xs text-muted-foreground">
                  Issue operations
                </span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={appNav} pathname={pathname} />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
