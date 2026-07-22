"use client"

import {
  ArrowLeft02Icon,
  ArrowRight02Icon,
  CustomizeIcon,
  LayoutAlignLeftIcon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { useRouter, useRouterState } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"

import type { AppNavChild } from "@/lib/app-navigation"
import type { DesktopTabsState } from "@/lib/desktop-tabs"
import type { SidebarState } from "@/lib/sidebar-events"
import type { TeamSummary } from "@/lib/team-contract"
import { TeamSidebarIcon } from "@/components/team-sidebar-icon"
import { Button } from "@/components/ui/button"
import { getForgeHost } from "@/host/forge-host"
import { appNav, getBreadcrumbItems } from "@/lib/app-navigation"
import {
  activateDesktopTab,
  closeDesktopTab,
  createDesktopTabs,
  getActiveDesktopTab,
  getDesktopTabPath,
  moveDesktopTabHistory,
  openDesktopTab,
  recordDesktopTabRoute,
  restoreDesktopTabs,
} from "@/lib/desktop-tabs"
import {
  SIDEBAR_STATE_CHANGE_EVENT,
  SIDEBAR_TOGGLE_EVENT,
} from "@/lib/sidebar-events"
import { listTeams } from "@/lib/team-state"

const STORAGE_KEY = "forge:desktop-tabs"

function getTabTitle(path: string) {
  const pathname = path.split(/[?#]/, 1)[0]
  return getBreadcrumbItems(pathname).at(-1)?.label ?? "Forge"
}

function getTabNavigationItem(path: string): AppNavChild | undefined {
  const pathname = path.split(/[?#]/, 1)[0]

  if (pathname.startsWith("/settings")) {
    return {
      title: "Preferences",
      to: "/settings",
      icon: CustomizeIcon,
    }
  }

  function findItem(items: Array<AppNavChild>): AppNavChild | undefined {
    for (const item of items) {
      const child = item.items ? findItem(item.items) : undefined
      if (child) return child
      if (item.to === pathname) return item
    }
  }

  const exactItem = findItem(appNav)
  if (exactItem) return exactItem

  if (pathname.startsWith("/workspace/initiatives/")) {
    return appNav
      .find((item) => item.title === "Workspace")
      ?.items?.find((item) => item.to === "/workspace/initiatives")
  }
}

export function TabIcon({
  path,
  team,
}: {
  path: string
  team?: Pick<TeamSummary, "icon" | "name">
}) {
  if (team) {
    return (
      <TeamSidebarIcon
        icon={team.icon}
        name={team.name}
        className="forge-desktop-tab-icon"
      />
    )
  }

  const item = getTabNavigationItem(path)

  if (item?.icon) {
    return (
      <HugeiconsIcon
        icon={item.icon}
        strokeWidth={2}
        className="forge-desktop-tab-icon"
      />
    )
  }

  return (
    <img
      src={item?.iconSrc ?? "/img/logo-forge-128px-nobg.png"}
      alt=""
      aria-hidden="true"
      className="forge-desktop-tab-icon"
    />
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3">
      <path
        d="m4.5 4.5 7 7m0-7-7 7"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-3.5">
      <path
        d="M8 3.5v9M3.5 8h9"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
    </svg>
  )
}

export function DesktopTitleBar() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })

  if (isDesktopTitleBarHidden(pathname)) return null

  return <DesktopTitleBarChrome />
}

export function isDesktopTitleBarHidden(pathname: string) {
  return (
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname === "/onboarding/workspace"
  )
}

function DesktopTitleBarChrome() {
  const router = useRouter()
  const currentPath = useRouterState({
    select: (state) => state.location.href,
  })
  const [tabState, setTabState] = useState<DesktopTabsState>(() =>
    createDesktopTabs(currentPath)
  )
  const [sidebarState, setSidebarState] = useState<SidebarState>("expanded")
  const [workspaceTeams, setWorkspaceTeams] = useState<Array<TeamSummary>>([])

  useEffect(() => {
    let cancelled = false

    void listTeams()
      .then((teams) => {
        if (!cancelled) setWorkspaceTeams(teams)
      })
      .catch(() => {
        if (!cancelled) setWorkspaceTeams([])
      })

    return () => {
      cancelled = true
    }
  }, [currentPath])

  useEffect(() => {
    const handleSidebarStateChange = (event: Event) => {
      setSidebarState((event as CustomEvent<SidebarState>).detail)
    }

    window.addEventListener(
      SIDEBAR_STATE_CHANGE_EVENT,
      handleSidebarStateChange
    )
    return () =>
      window.removeEventListener(
        SIDEBAR_STATE_CHANGE_EVENT,
        handleSidebarStateChange
      )
  }, [])

  const navigate = useCallback(
    (path: string) => void router.navigate({ href: path }),
    [router]
  )

  const openTab = useCallback(
    (path = "/forge") => {
      setTabState((state) => openDesktopTab(state, path))
      navigate(path)
    },
    [navigate]
  )

  const closeTab = useCallback(
    (tabId: string) => {
      setTabState((state) => {
        const nextState = closeDesktopTab(state, tabId)
        if (nextState !== state && state.activeTabId === tabId) {
          const activeTab = getActiveDesktopTab(nextState)
          navigate(getDesktopTabPath(activeTab))
        }
        return nextState
      })
    },
    [navigate]
  )

  const moveHistory = useCallback(
    (delta: -1 | 1) => {
      setTabState((state) => {
        const nextState = moveDesktopTabHistory(state, delta)
        if (nextState !== state) {
          const activeTab = getActiveDesktopTab(nextState)
          navigate(getDesktopTabPath(activeTab))
        }
        return nextState
      })
    },
    [navigate]
  )

  useEffect(() => {
    if (!window.forgeDesktop) return

    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null")
      setTabState(restoreDesktopTabs(saved, currentPath))
    } catch {
      setTabState(createDesktopTabs(currentPath))
    }
  }, []) // Restore once; subsequent route changes are recorded below.

  useEffect(() => {
    if (!window.forgeDesktop) return
    setTabState((state) => recordDesktopTabRoute(state, currentPath))
  }, [currentPath])

  useEffect(() => {
    if (!window.forgeDesktop) return
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tabState))
  }, [tabState])

  useEffect(() => {
    if (!window.forgeDesktop) return

    return getForgeHost().subscribe((event) => {
      if (event.type !== "command") return
      if (event.command === "new-tab") openTab()
      if (event.command === "close-tab") closeTab(tabState.activeTabId)
      if (event.command === "tab-back") moveHistory(-1)
      if (event.command === "tab-forward") moveHistory(1)
    })
  }, [closeTab, moveHistory, openTab, tabState.activeTabId])

  useEffect(() => {
    if (!window.forgeDesktop) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) {
        return
      }

      const tabNumber = Number(event.key)
      if (tabNumber >= 1 && tabNumber <= Math.min(9, tabState.tabs.length)) {
        const tab = tabState.tabs[tabNumber - 1]
        event.preventDefault()
        setTabState((state) => activateDesktopTab(state, tab.id))
        navigate(getDesktopTabPath(tab))
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [navigate, tabState.tabs])

  useEffect(() => {
    if (!window.forgeDesktop) return

    const openLinkInTab = (event: MouseEvent) => {
      if (!(event.metaKey || event.ctrlKey || event.button === 1)) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest("a[href]")
      if (!(anchor instanceof HTMLAnchorElement)) return

      const url = new URL(anchor.href, window.location.href)
      if (url.origin !== window.location.origin) return

      event.preventDefault()
      openTab(`${url.pathname}${url.search}${url.hash}`)
    }

    document.addEventListener("click", openLinkInTab, true)
    document.addEventListener("auxclick", openLinkInTab, true)
    return () => {
      document.removeEventListener("click", openLinkInTab, true)
      document.removeEventListener("auxclick", openLinkInTab, true)
    }
  }, [openTab])

  const activeTab = getActiveDesktopTab(tabState)
  const canGoBack = activeTab.historyIndex > 0
  const canGoForward = activeTab.historyIndex < activeTab.history.length - 1

  return (
    <div className="forge-desktop-titlebar" data-testid="desktop-titlebar">
      <div className="forge-desktop-titlebar-controls">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-state={sidebarState}
          aria-label="Toggle sidebar"
          title="Toggle sidebar"
          onClick={() => window.dispatchEvent(new Event(SIDEBAR_TOGGLE_EVENT))}
        >
          <HugeiconsIcon
            icon={
              sidebarState === "collapsed"
                ? LayoutAlignLeftIcon
                : SidebarLeftIcon
            }
            strokeWidth={2}
            className="size-4"
          />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Go back"
          title="Go back"
          disabled={!canGoBack}
          onClick={() => moveHistory(-1)}
        >
          <HugeiconsIcon
            icon={ArrowLeft02Icon}
            strokeWidth={2}
            className="size-4"
          />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Go forward"
          title="Go forward"
          disabled={!canGoForward}
          onClick={() => moveHistory(1)}
        >
          <HugeiconsIcon
            icon={ArrowRight02Icon}
            strokeWidth={2}
            className="size-4"
          />
        </Button>
      </div>

      <div className="forge-desktop-tabs" role="tablist" aria-label="Open tabs">
        {tabState.tabs.map((tab) => {
          const path = getDesktopTabPath(tab)
          const isActive = tab.id === tabState.activeTabId
          const teamSlug = path
            .split(/[?#]/, 1)[0]
            .match(/^\/teams\/([^/]+)\/(issues|projects|views)$/)?.[1]
          const team = teamSlug
            ? workspaceTeams.find((item) => item.slug === teamSlug)
            : undefined
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              className="forge-desktop-tab"
              data-active={isActive || undefined}
            >
              <button
                type="button"
                className="forge-desktop-tab-target"
                title={getTabTitle(path)}
                onClick={() => {
                  setTabState((state) => activateDesktopTab(state, tab.id))
                  navigate(path)
                }}
              >
                <TabIcon path={path} team={team} />
                <span>{getTabTitle(path)}</span>
              </button>
              {tabState.tabs.length > 1 ? (
                <button
                  type="button"
                  className="forge-desktop-tab-close"
                  aria-label={`Close ${getTabTitle(path)} tab`}
                  onClick={() => closeTab(tab.id)}
                >
                  <CloseIcon />
                </button>
              ) : null}
            </div>
          )
        })}
        <button
          type="button"
          className="forge-desktop-new-tab"
          aria-label="New tab"
          title="New tab (⌘T)"
          onClick={() => openTab()}
        >
          <PlusIcon />
        </button>
      </div>
    </div>
  )
}
