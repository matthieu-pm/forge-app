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
import { Cursor02Icon, HistoryIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { Fragment } from "react"

import appCss from "../styles.css?url"
import { AppSidebar } from "@/components/app-sidebar"
import { SettingsSidebar } from "@/components/settings-sidebar"
import { DesktopTitleBar } from "@/components/desktop-title-bar"
import { Button } from "@/components/ui/button"
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
        type: "image/png",
        sizes: "512x512",
        href: "/favicon.png?v=forge-512-20260722",
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
    "/auth/desktop",
    "/login",
    "/signup",
    "/onboarding/workspace",
  ])

  if (shelllessPaths.has(pathname)) {
    return <Outlet key={pathname} />
  }

  const hasStandaloneTeamSettingsLayout =
    pathname.startsWith("/settings/teams/")

  return (
    <SidebarProvider
      className={
        hasStandaloneTeamSettingsLayout ? "forge-create-team-shell" : undefined
      }
    >
      {pathname.startsWith("/settings") ? <SettingsSidebar /> : <AppSidebar />}
      <SidebarInset>
        <AppHeader pathname={pathname} />
        <Outlet key={pathname} />
      </SidebarInset>
      <DesktopFooterActions />
    </SidebarProvider>
  )
}

function DesktopFooterActions() {
  return (
    <div className="forge-desktop-footer-actions" aria-label="Forge actions">
      <Button
        nativeButton={false}
        variant="ghost"
        size="xs"
        className="forge-ask-button text-muted-foreground hover:text-foreground"
        aria-label="Ask Forge"
        render={<Link to="/agent" />}
      >
        <HugeiconsIcon icon={Cursor02Icon} strokeWidth={2} />
        <span className="forge-rolling-label" aria-hidden="true">
          {[..."Ask Forge"].map((character, index) => (
            <span
              key={`${character}-${index}`}
              className="forge-rolling-letter"
            >
              <span
                className="forge-rolling-letter-track"
                style={{ transitionDelay: `${index * 35}ms` }}
              >
                <span>{character === " " ? "\u00a0" : character}</span>
                <span>{character === " " ? "\u00a0" : character}</span>
              </span>
            </span>
          ))}
        </span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-muted-foreground hover:text-foreground"
        aria-label="History"
        title="History"
      >
        <HugeiconsIcon icon={HistoryIcon} strokeWidth={2} />
      </Button>
    </div>
  )
}

function AppHeader({ pathname }: { pathname: string }) {
  if (pathname.startsWith("/settings/teams/")) {
    return null
  }

  const breadcrumbs = getBreadcrumbItems(pathname)

  function renderBreadcrumbLink(to: string) {
    return to.startsWith("/teams/") ? (
      <a href={to} />
    ) : (
      <Link to={to as never} />
    )
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 px-4">
      <Breadcrumb>
        <BreadcrumbList className="text-sm">
          {breadcrumbs.map((item, index) => {
            const isLast = index === breadcrumbs.length - 1

            return (
              <Fragment key={`${item.label}-${index}`}>
                <BreadcrumbItem>
                  {item.to && !isLast ? (
                    <BreadcrumbLink render={renderBreadcrumbLink(item.to)}>
                      {item.label}
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage className="text-sm font-medium">
                      {item.label}
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
