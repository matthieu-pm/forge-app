import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserWindow, dialog, screen, shell } from "electron"
import Conf from "conf"

import { routePathSchema } from "../shared/bridge-contract"
import { classifyNavigation } from "./navigation-policy"
import { createWindowOptions, restoreVisibleBounds } from "./window-config"
import type { Rectangle } from "electron"
import type { HostEvent } from "../../src/host/forge-host"

type WindowState = {
  bounds?: Rectangle
  maximized?: boolean
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

export class WindowManager {
  readonly #windows = new Set<BrowserWindow>()
  readonly #state = new Conf<WindowState>({
    projectName: "Forge",
    configName: "window-state",
  })

  constructor(
    readonly appOrigin: string,
    readonly development: boolean
  ) {}

  create(path = "/") {
    const route = routePathSchema.parse(path)
    const bounds = restoreVisibleBounds(
      this.#state.get("bounds"),
      screen.getAllDisplays().map((display) => display.workArea)
    )
    const window = new BrowserWindow(
      createWindowOptions(
        join(moduleDirectory, "preload.cjs"),
        bounds,
        this.development
      )
    )

    this.#windows.add(window)
    this.#configureNavigation(window)

    if (process.platform === "darwin") {
      window.webContents.on("dom-ready", () => {
        void window.webContents.executeJavaScript(
          'document.documentElement.dataset.forgeHost = "macos"'
        )
      })
    }

    window.once("ready-to-show", () => {
      if (this.#state.get("maximized")) {
        window.maximize()
      }
      window.show()
    })

    window.on("close", () => {
      if (!window.isFullScreen()) {
        this.#state.set("maximized", window.isMaximized())
        if (!window.isMaximized()) {
          this.#state.set("bounds", window.getBounds())
        }
      }
    })

    window.on("closed", () => {
      this.#windows.delete(window)
    })

    window.webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (!isMainFrame || errorCode === -3 || window.isDestroyed()) {
          return
        }

        void this.#showLoadFailure(window, errorDescription)
      }
    )

    void window.loadURL(new URL(route, this.appOrigin).toString())
    return window
  }

  getFocused() {
    return (
      BrowserWindow.getFocusedWindow() ??
      [...this.#windows].find((window) => !window.isDestroyed()) ??
      null
    )
  }

  hasWindows() {
    return this.#windows.size > 0
  }

  focusOrCreate() {
    const window = this.getFocused() ?? this.create()
    if (window.isMinimized()) {
      window.restore()
    }
    window.show()
    window.focus()
    return window
  }

  navigate(path: string, target = this.getFocused()) {
    const route = routePathSchema.parse(path)
    const window = target ?? this.create(route)

    if (!target) {
      return window
    }

    if (window.isMinimized()) {
      window.restore()
    }
    window.show()
    window.focus()
    void window.loadURL(new URL(route, this.appOrigin).toString())
    return window
  }

  broadcast(event: HostEvent) {
    for (const window of this.#windows) {
      if (!window.isDestroyed()) {
        window.webContents.send("forge:host:event", event)
      }
    }
  }

  broadcastExcept(event: HostEvent, excludedWebContentsId: number) {
    for (const window of this.#windows) {
      if (
        !window.isDestroyed() &&
        window.webContents.id !== excludedWebContentsId
      ) {
        window.webContents.send("forge:host:event", event)
      }
    }
  }

  sendToFocused(event: HostEvent) {
    this.getFocused()?.webContents.send("forge:host:event", event)
  }

  #configureNavigation(window: BrowserWindow) {
    window.webContents.on("will-navigate", (event, url) => {
      const decision = classifyNavigation(url, this.appOrigin)

      if (decision.action === "allow") {
        return
      }

      event.preventDefault()
      if (decision.action === "open-external") {
        void shell.openExternal(decision.url)
      }
    })

    window.webContents.setWindowOpenHandler(({ url }) => {
      const decision = classifyNavigation(url, this.appOrigin)

      if (decision.action === "allow") {
        const target = new URL(url)
        this.create(`${target.pathname}${target.search}${target.hash}`)
      } else if (decision.action === "open-external") {
        void shell.openExternal(decision.url)
      }

      return { action: "deny" }
    })

    window.webContents.on("will-attach-webview", (event) => {
      event.preventDefault()
    })
  }

  async #showLoadFailure(window: BrowserWindow, errorDescription: string) {
    const result = await dialog.showMessageBox(window, {
      type: "warning",
      title: "Forge couldn’t connect",
      message: "Forge couldn’t reach the application server.",
      detail: errorDescription,
      buttons: ["Retry", "Close Window"],
      defaultId: 0,
      cancelId: 1,
    })

    if (window.isDestroyed()) {
      return
    }

    if (result.response === 0) {
      window.webContents.reload()
    } else {
      window.close()
    }
  }
}
