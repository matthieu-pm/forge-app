"use client"

import * as React from "react"

import { readAppearanceCache } from "@/lib/appearance"
import { getForgeHost } from "@/host/forge-host"
import {
  applyPersonalInterfacePreferences,
  defaultPersonalPreferences,
} from "@/lib/personal-preferences"

/** Applies the signed-in user's cached appearance before workspace data loads. */
export function AppearanceStartup({ userId }: { userId: string | null }) {
  React.useLayoutEffect(() => {
    const cached =
      userId && typeof localStorage !== "undefined"
        ? readAppearanceCache(localStorage, userId)
        : null
    const choice = cached ?? {
      interfaceTheme: defaultPersonalPreferences.interfaceTheme,
      lightTheme: defaultPersonalPreferences.lightTheme,
      darkTheme: defaultPersonalPreferences.darkTheme,
    }
    applyPersonalInterfacePreferences({
      ...defaultPersonalPreferences,
      ...choice,
    })
    void getForgeHost().setThemeSource(choice.interfaceTheme)
  }, [userId])

  return null
}
