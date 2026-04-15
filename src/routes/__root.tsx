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

import { AppSidebar } from "@/components/app-sidebar"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { getBreadcrumbItems } from "@/lib/app-navigation"
import {
  PageHeaderProvider,
  usePageHeaderValue,
} from "@/lib/page-header"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import appCss from "../styles.css?url"

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
  const shelllessPaths = new Set([
    "/login",
    "/signup",
    "/onboarding/workspace",
  ])

  if (shelllessPaths.has(pathname)) {
    return <Outlet key={pathname} />
  }

  return (
    <PageHeaderProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <AppHeader pathname={pathname} />
          <Outlet key={pathname} />
        </SidebarInset>
      </SidebarProvider>
    </PageHeaderProvider>
  )
}

function AppHeader({ pathname }: { pathname: string }) {
  const breadcrumbs = getBreadcrumbItems(pathname)
  const { inline, actions } = usePageHeaderValue()

  function renderBreadcrumbLink(to: string) {
    return to.startsWith("/teams/") ? (
      <a href={to} />
    ) : (
      <Link to={to as never} />
    )
  }

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 px-4">
      <SidebarTrigger className="-ml-1" />
      <Breadcrumb>
        <BreadcrumbList className="text-sm">
          {breadcrumbs.map((item, index) => {
            const isLast = index === breadcrumbs.length - 1

            return (
              <BreadcrumbItem key={`${item.label}-${index}`}>
                {item.to && !isLast ? (
                  <BreadcrumbLink render={renderBreadcrumbLink(item.to)}>
                    {item.label}
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="text-sm font-medium">
                    {item.label}
                  </BreadcrumbPage>
                )}
                {!isLast ? <BreadcrumbSeparator /> : null}
              </BreadcrumbItem>
            )
          })}
        </BreadcrumbList>
      </Breadcrumb>
      {inline}
      {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
    </header>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
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
