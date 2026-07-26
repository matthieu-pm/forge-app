export type DesktopTab = {
  id: string
  history: Array<string>
  historyIndex: number
}

export type DesktopTabsState = {
  tabs: Array<DesktopTab>
  activeTabId: string
}

let nextTabId = 0

function createTab(path: string): DesktopTab {
  nextTabId += 1
  return {
    id: `tab-${Date.now().toString(36)}-${nextTabId.toString(36)}`,
    history: [path],
    historyIndex: 0,
  }
}

export function createDesktopTabs(path: string): DesktopTabsState {
  const tab = createTab(path)
  return { tabs: [tab], activeTabId: tab.id }
}

export function getActiveDesktopTab(state: DesktopTabsState) {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? state.tabs[0]
}

export function getDesktopTabPath(tab: DesktopTab) {
  return tab.history[tab.historyIndex] ?? "/forge"
}

export function recordDesktopTabRoute(
  state: DesktopTabsState,
  path: string
): DesktopTabsState {
  const activeTab = getActiveDesktopTab(state)
  if (getDesktopTabPath(activeTab) === path) {
    return state
  }

  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === activeTab.id
        ? {
            ...tab,
            history: [...tab.history.slice(0, tab.historyIndex + 1), path],
            historyIndex: tab.historyIndex + 1,
          }
        : tab
    ),
  }
}

export function openDesktopTab(
  state: DesktopTabsState,
  path: string
): DesktopTabsState {
  const tab = createTab(path)
  return {
    tabs: [...state.tabs, tab],
    activeTabId: tab.id,
  }
}

export function activateDesktopTab(
  state: DesktopTabsState,
  tabId: string
): DesktopTabsState {
  return state.tabs.some((tab) => tab.id === tabId)
    ? { ...state, activeTabId: tabId }
    : state
}

export function closeDesktopTab(
  state: DesktopTabsState,
  tabId: string
): DesktopTabsState {
  if (state.tabs.length === 1) {
    return state
  }

  const closingIndex = state.tabs.findIndex((tab) => tab.id === tabId)
  if (closingIndex === -1) {
    return state
  }

  const tabs = state.tabs.filter((tab) => tab.id !== tabId)
  const activeTabId =
    state.activeTabId === tabId
      ? tabs[Math.min(closingIndex, tabs.length - 1)].id
      : state.activeTabId

  return { tabs, activeTabId }
}

export function moveDesktopTabHistory(
  state: DesktopTabsState,
  delta: -1 | 1
): DesktopTabsState {
  const activeTab = getActiveDesktopTab(state)
  const historyIndex = activeTab.historyIndex + delta
  if (historyIndex < 0 || historyIndex >= activeTab.history.length) {
    return state
  }

  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.id === activeTab.id ? { ...tab, historyIndex } : tab
    ),
  }
}

export function restoreDesktopTabs(
  value: unknown,
  currentPath: string
): DesktopTabsState {
  if (!value || typeof value !== "object") {
    return createDesktopTabs(currentPath)
  }

  const candidate = value as Partial<DesktopTabsState>
  if (
    !Array.isArray(candidate.tabs) ||
    candidate.tabs.length === 0 ||
    typeof candidate.activeTabId !== "string"
  ) {
    return createDesktopTabs(currentPath)
  }

  const tabs = candidate.tabs.filter(
    (tab): tab is DesktopTab =>
      Boolean(tab) &&
      typeof tab.id === "string" &&
      Array.isArray(tab.history) &&
      tab.history.length > 0 &&
      tab.history.every(
        (path) => typeof path === "string" && path.startsWith("/")
      ) &&
      Number.isInteger(tab.historyIndex) &&
      tab.historyIndex >= 0 &&
      tab.historyIndex < tab.history.length
  )

  if (tabs.length === 0) {
    return createDesktopTabs(currentPath)
  }

  const activeTabId = tabs.some((tab) => tab.id === candidate.activeTabId)
    ? candidate.activeTabId
    : tabs[0].id
  const restored = { tabs, activeTabId }

  // The address loaded by Electron is authoritative on reload and deep-link opens.
  return recordDesktopTabRoute(restored, currentPath)
}
