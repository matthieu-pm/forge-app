export const PREFERENCES_STORAGE_KEY = "forge.personal-preferences"

export type InterfaceTheme = "system" | "light" | "dark"
export type LightTheme = "light" | "paper"
export type DarkTheme = "dark" | "midnight" | "forest" | "plum"
export type FontSize = "small" | "default" | "large"

export type PersonalPreferences = {
  defaultHomeView: "agent" | "inbox" | "my-issues"
  displayNames: "username" | "full-name"
  firstDayOfWeek: "sunday" | "monday" | "saturday"
  convertEmoticons: boolean
  submitCommentsWith: "command-enter" | "enter"
  fontSize: FontSize
  pointerCursors: boolean
  underlineLinks: boolean
  interfaceTheme: InterfaceTheme
  lightTheme: LightTheme
  darkTheme: DarkTheme
  notificationBadge: "unread" | "count" | "off"
  checkSpelling: boolean
  autoAssignToSelf: boolean
  assignStartedIssues: boolean
}

export const defaultPersonalPreferences: PersonalPreferences = {
  defaultHomeView: "agent",
  displayNames: "username",
  firstDayOfWeek: "sunday",
  convertEmoticons: true,
  submitCommentsWith: "command-enter",
  fontSize: "default",
  pointerCursors: false,
  underlineLinks: false,
  interfaceTheme: "system",
  lightTheme: "light",
  darkTheme: "dark",
  notificationBadge: "unread",
  checkSpelling: true,
  autoAssignToSelf: false,
  assignStartedIssues: false,
}

export function loadPersonalPreferences(): PersonalPreferences {
  try {
    const stored = window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
    return stored
      ? {
          ...defaultPersonalPreferences,
          ...(JSON.parse(stored) as Partial<PersonalPreferences>),
        }
      : defaultPersonalPreferences
  } catch {
    return defaultPersonalPreferences
  }
}

export function applyPersonalInterfacePreferences(
  preferences: PersonalPreferences
) {
  const root = document.documentElement
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
  const useDarkTheme =
    preferences.interfaceTheme === "dark" ||
    (preferences.interfaceTheme === "system" && prefersDark)
  const resolvedTheme = useDarkTheme
    ? preferences.darkTheme
    : preferences.lightTheme

  root.classList.toggle("dark", useDarkTheme)
  root.dataset.forgeTheme = resolvedTheme
  root.dataset.forgePointerCursors = String(preferences.pointerCursors)
  root.dataset.forgeUnderlineLinks = String(preferences.underlineLinks)
  root.style.fontSize = {
    small: "15px",
    default: "16px",
    large: "17px",
  }[preferences.fontSize]
}
