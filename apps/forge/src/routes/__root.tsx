import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"
import { Activity, Fragment } from "react"

import appCss from "../styles.css?url"
import { AppSidebar } from "@/components/app-sidebar"
import { AgentProvider, useAgent } from "@/components/agent/agent-provider"
import { AgentFooterActions } from "@/components/agent/agent-footer-actions"
import { AgentShell } from "@/components/agent/agent-shell"
import { SettingsSidebar } from "@/components/settings-sidebar"
import { DesktopTitleBar } from "@/components/desktop-title-bar"
import { WorkspaceEmojiProvider } from "@/components/custom-emoji-provider"
import { PersonalPreferenceEffects } from "@/components/personal-preference-effects"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Toaster } from "@/components/ui/sonner"
import { HostIntegration } from "@/host/host-integration"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { getBreadcrumbItems } from "@/lib/app-navigation"
import { getSettingsBreadcrumbItems } from "@/lib/settings-navigation"
import { getTeamFromRouteMatches } from "@/lib/team-route-match"
import { cn } from "@/lib/utils"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "Forge",
      },
    ],
    links: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/img/forge-app-icon-black.svg",
        media: "(prefers-color-scheme: light)",
      },
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/img/forge-app-icon-white.svg",
        media: "(prefers-color-scheme: dark)",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "512x512",
        href: "/favicon.png?v=forge-512-20260801",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),
  component: RootLayout,
  shellComponent: RootDocument,
})

function RootLayout() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const shelllessPaths = new Set([
    "/accept-invitation",
    "/auth/desktop",
    "/download",
    "/login",
    "/signup",
    "/onboarding/workspace",
  ])

  if (shelllessPaths.has(pathname)) {
    return <Outlet key={pathname} />
  }

  const hasStandaloneTeamSettingsLayout =
    pathname.startsWith("/settings/teams/")
  const hasSettingsLayout = pathname.startsWith("/settings")

  return (
    <WorkspaceEmojiProvider>
      <AgentProvider deferModelSources={pathname !== "/forge"}>
        <SidebarProvider
          className={cn(
            "forge-app-shell relative",
            pathname === "/inbox" && "forge-inbox-shell",
            (pathname === "/my-issues" ||
              /^\/teams\/[^/]+\/issues$/.test(pathname)) &&
              "forge-issues-shell",
            hasStandaloneTeamSettingsLayout
              ? "forge-create-team-shell forge-settings-shell"
              : hasSettingsLayout
                ? "forge-settings-shell"
                : undefined
          )}
        >
          <PersonalPreferenceEffects />
          <Activity mode={hasSettingsLayout ? "hidden" : "visible"}>
            <AppSidebar />
          </Activity>
          <Activity mode={hasSettingsLayout ? "visible" : "hidden"}>
            <SettingsSidebar />
          </Activity>
          <AgentContentPane pathname={pathname} />
          <div className="forge-agent-overlay-layer pointer-events-none absolute top-2 right-2 bottom-8 left-0 z-30 transition-[left] duration-200 ease-linear md:left-(--sidebar-width) md:peer-data-[collapsible=icon]:left-[calc(var(--sidebar-width-icon)+(--spacing(4)))] md:peer-data-[collapsible=offcanvas]:left-0">
            <AgentShell />
          </div>
          <AgentFooterActions />
        </SidebarProvider>
      </AgentProvider>
    </WorkspaceEmojiProvider>
  )
}

function AgentContentPane({ pathname }: { pathname: string }) {
  const { surfaceMode } = useAgent()
  const obscured = surfaceMode === "maximized"

  return (
    <SidebarInset
      className={cn(
        "origin-center transition-transform duration-150 ease-out",
        pathname === "/workspace/teams" && "overflow-hidden",
        obscured && "scale-x-[0.98] scale-y-[0.99]"
      )}
    >
      <AgentRouteContent pathname={pathname} obscured={obscured} />
    </SidebarInset>
  )
}

function AgentRouteContent({
  pathname,
  obscured,
}: {
  pathname: string
  obscured: boolean
}) {
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      aria-hidden={obscured || undefined}
      inert={obscured || undefined}
    >
      {pathname !== "/inbox" &&
        pathname !== "/my-issues" &&
        !pathname.startsWith("/workspace/initiatives") &&
        pathname !== "/workspace/projects" &&
        !/^\/teams\/[^/]+\/cycle\/[^/]+$/.test(pathname) &&
        !/^\/teams\/[^/]+\/(triage|overview|documents|loops|members|issues|projects)$/.test(
          pathname
        ) && <AppHeader />}
      <div
        data-slot="route-viewport"
        className="flex min-h-0 flex-1 flex-col overflow-auto overscroll-contain"
      >
        <Outlet key={pathname} />
      </div>
    </div>
  )
}

function AppHeader() {
  const { breadcrumbTeam, pathname } = useRouterState({
    select: (state) => {
      const resolvedPathname =
        state.resolvedLocation?.pathname ?? state.location.pathname

      if (
        !/^\/teams\/[^/]+\/(issues|projects|views)$/.test(resolvedPathname) &&
        !resolvedPathname.startsWith("/settings/teams/")
      ) {
        return { breadcrumbTeam: undefined, pathname: resolvedPathname }
      }

      return {
        breadcrumbTeam: getTeamFromRouteMatches(state.matches),
        pathname: resolvedPathname,
      }
    },
  })

  if (pathname === "/workspace/teams") {
    return null
  }

  const settings = pathname === "/settings" || pathname.startsWith("/settings/")
  const breadcrumbs = settings
    ? getSettingsBreadcrumbItems(pathname, breadcrumbTeam)
    : getBreadcrumbItems(pathname)

  function renderBreadcrumbLink(to: string) {
    return <Link to={to as never} />
  }

  return (
    <header className="flex h-12 min-w-0 shrink-0 items-center gap-3 px-4">
      <Breadcrumb className="min-w-0 overflow-x-auto whitespace-nowrap">
        <BreadcrumbList className="h-6 flex-nowrap text-sm">
          {breadcrumbs.map((item, index) => {
            const isLast = index === breadcrumbs.length - 1
            const showTeamIcon = settings
              ? item.to === `/settings/teams/${breadcrumbTeam?.slug}`
              : index === 0
            const team = showTeamIcon ? breadcrumbTeam : undefined
            const label = team ? (
              <span className="inline-flex items-center gap-1.5">
                <TeamSidebarIcon icon={team.icon} name={team.name} />
                <span>{item.label}</span>
              </span>
            ) : (
              item.label
            )

            return (
              <Fragment key={`${item.label}-${index}`}>
                <BreadcrumbItem>
                  {item.to && !isLast ? (
                    <BreadcrumbLink render={renderBreadcrumbLink(item.to)}>
                      {label}
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage className="text-sm font-medium">
                      {label}
                    </BreadcrumbPage>
                  )}
                </BreadcrumbItem>
                {!isLast ? <BreadcrumbSeparator /> : null}
              </Fragment>
            )
          })}
        </BreadcrumbList>
      </Breadcrumb>
    </header>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <DesktopTitleBar />
        {children}
        <HostIntegration />
        <Toaster />
        <TanStackDevtools
          config={{
            position: "bottom-left",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
