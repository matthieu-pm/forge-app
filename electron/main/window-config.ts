import type { BrowserWindowConstructorOptions, Rectangle } from "electron"

export function restoreVisibleBounds(
  bounds: Rectangle | undefined,
  workAreas: Array<Rectangle>
): Rectangle | undefined {
  if (
    !bounds ||
    !Object.values(bounds).every(Number.isFinite) ||
    bounds.width < 320 ||
    bounds.height < 240
  ) {
    return undefined
  }

  const isVisible = workAreas.some((area) => {
    const overlapWidth =
      Math.min(bounds.x + bounds.width, area.x + area.width) -
      Math.max(bounds.x, area.x)
    const overlapHeight =
      Math.min(bounds.y + bounds.height, area.y + area.height) -
      Math.max(bounds.y, area.y)

    return overlapWidth >= 64 && overlapHeight >= 64
  })

  return isVisible ? bounds : undefined
}

export function createWindowOptions(
  preload: string,
  bounds?: Partial<Rectangle>,
  development = false
): BrowserWindowConstructorOptions {
  return {
    width: bounds?.width ?? 1280,
    height: bounds?.height ?? 800,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: "#ffffff",
    titleBarStyle: "hidden",
    show: false,
    webPreferences: {
      preload,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: development,
    },
  }
}
