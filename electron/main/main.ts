import { join } from "node:path"
import { app, nativeTheme, session } from "electron"

import { configureAppAppearance } from "./appearance"
import { setDockIconSafely } from "./dock-icon"
import { registerHostBridge } from "./host-bridge"
import { installApplicationMenu } from "./menu"
import { routeFromDeepLink } from "./navigation-policy"
import { productDeepLinkScheme, resolveAppOrigin } from "./runtime-config"
import { configureSessionSecurity } from "./security"
import { setupDesktopAuth } from "./desktop-auth"
import { configureUpdater } from "./updater"
import { WindowManager } from "./window-manager"

app.setName("Forge")
configureAppAppearance(nativeTheme)

const appOrigin = resolveAppOrigin(app.isPackaged)
const windows = new WindowManager(appOrigin, !app.isPackaged)
const queuedRoutes: Array<string> = []

function handleDeepLink(value: string) {
  const route = routeFromDeepLink(value)
  if (!route) return

  if (app.isReady()) {
    windows.navigate(route)
  } else {
    queuedRoutes.push(route)
  }
}

function deepLinkFromArguments(arguments_: Array<string>) {
  return arguments_.find((argument) => argument.startsWith("forge://"))
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  const desktopAuth = setupDesktopAuth(appOrigin, () => windows.getFocused())
  app.setAsDefaultProtocolClient(productDeepLinkScheme)

  app.on("open-url", (event, url) => {
    event.preventDefault()
    handleDeepLink(url)
  })

  app.on("second-instance", (_event, commandLine) => {
    const deepLink = deepLinkFromArguments(commandLine)
    if (deepLink) handleDeepLink(deepLink)
    else windows.focusOrCreate()
  })

  app.whenReady().then(async () => {
    if (process.platform === "darwin" && !app.isPackaged) {
      setDockIconSafely(
        app.dock,
        join(process.cwd(), "desktop/assets/forge-icon.png")
      )
    }

    configureSessionSecurity(appOrigin)
    await desktopAuth.restore(session.defaultSession)
    registerHostBridge(windows, appOrigin, desktopAuth)
    const updater = configureUpdater(windows)
    installApplicationMenu(windows, updater.check)

    const initialRoute = queuedRoutes.shift() ?? "/"
    windows.create(initialRoute)
    for (const route of queuedRoutes.splice(0)) {
      windows.navigate(route)
    }

    const startupDeepLink = deepLinkFromArguments(process.argv)
    if (startupDeepLink) handleDeepLink(startupDeepLink)
  })

  app.on("activate", () => {
    if (!windows.hasWindows()) windows.create()
    else windows.focusOrCreate()
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  app.on("before-quit", () => {
    session.defaultSession.flushStorageData()
  })
}
