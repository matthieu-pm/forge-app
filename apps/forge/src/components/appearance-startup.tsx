"use client"

import * as React from "react"

import { readAppearanceCache } from "@/lib/appearance"
import { getForgeHost } from "@/host/forge-host"
import {
  applyPersonalInterfacePreferences,
  defaultPersonalPreferences,
} from "@/lib/personal-preferences"

function cachedAppearance(userId: string | null) {
  const cached =
    userId && typeof localStorage !== "undefined"
      ? readAppearanceCache(localStorage, userId)
      : null
  return (
    cached ?? {
      interfaceTheme: defaultPersonalPreferences.interfaceTheme,
      lightTheme: defaultPersonalPreferences.lightTheme,
      darkTheme: defaultPersonalPreferences.darkTheme,
    }
  )
}

/** Applies the signed-in user's cached appearance before workspace data loads. */
export function AppearanceStartup({ userId }: { userId: string | null }) {
  React.useLayoutEffect(() => {
    const apply = () => {
      const choice = cachedAppearance(userId)
      applyPersonalInterfacePreferences(
        { ...defaultPersonalPreferences, ...choice },
        { appearanceOnly: true }
      )
      void getForgeHost().setThemeSource(choice.interfaceTheme)
    }
    apply()
    if (
      cachedAppearance(userId).interfaceTheme !== "system" ||
      typeof window.matchMedia !== "function"
    )
      return
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)")
    if (typeof colorScheme.addEventListener !== "function") return
    colorScheme.addEventListener("change", apply)
    return () => colorScheme.removeEventListener("change", apply)
  }, [userId])

  return null
}
