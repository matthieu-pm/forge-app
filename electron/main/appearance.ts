type NativeThemeController = {
  themeSource: string
}

export function configureAppAppearance(theme: NativeThemeController) {
  theme.themeSource = "light"
}
