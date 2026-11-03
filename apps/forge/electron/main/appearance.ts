type NativeThemeController = {
  themeSource: string
}

export type AppThemeSource = "system" | "light" | "dark"

export function configureAppAppearance(
  theme: NativeThemeController,
  source: AppThemeSource = "system"
) {
  theme.themeSource = source
}

/** Opaque window chrome. macOS keeps the transparent vibrancy material instead. */
export function hostWindowBackground(
  source: AppThemeSource,
  prefersDark: boolean,
  platform: NodeJS.Platform
) {
  if (platform === "darwin") return null
  const dark = source === "dark" || (source === "system" && prefersDark)
  return dark ? "#111111" : "#ffffff"
}
