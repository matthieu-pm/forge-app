type DockIconController = {
  setIcon: (iconPath: string) => void
}

export function setDockIconSafely(
  dock: DockIconController | undefined,
  iconPath: string
) {
  if (!dock) return false

  try {
    dock.setIcon(iconPath)
    return true
  } catch {
    return false
  }
}
