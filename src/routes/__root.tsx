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
import { Fragment } from "react"

import appCss from "../styles.css?url"
import { AppSidebar } from "@/components/app-sidebar"
import { SettingsSidebar } from "@/components/settings-sidebar"
import { DesktopTitleBar } from "@/components/desktop-title-bar"
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
        href: "/img/Logo%20Forge.png",
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
  const shelllessPaths = new Set(["/login", "/signup", "/onboarding/workspace"])

  if (shelllessPaths.has(pathname)) {
    return <Outlet key={pathname} />
  }

  return (
    <SidebarProvider>
      {pathname === "/settings" ? <SettingsSidebar /> : <AppSidebar />}
      <SidebarInset>
        <AppHeader pathname={pathname} />
        <Outlet key={pathname} />
      </SidebarInset>
    </SidebarProvider>
  )
}

function AppHeader({ pathname }: { pathname: string }) {
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
            position: "bottom-right",
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
