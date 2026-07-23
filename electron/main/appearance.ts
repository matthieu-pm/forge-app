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
