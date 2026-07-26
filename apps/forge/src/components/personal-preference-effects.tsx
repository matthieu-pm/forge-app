"use client"

import * as React from "react"

import {
  applyPersonalInterfacePreferences,
  loadPersonalPreferences,
} from "@/lib/personal-preferences"
import { getForgeHost } from "@/host/forge-host"

export function PersonalPreferenceEffects() {
  React.useEffect(() => {
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)")
    const applyPreferences = () => {
      const preferences = loadPersonalPreferences()
      applyPersonalInterfacePreferences(preferences)
      void getForgeHost().setThemeSource(preferences.interfaceTheme)
    }

    applyPreferences()
    colorScheme.addEventListener("change", applyPreferences)
    return () => colorScheme.removeEventListener("change", applyPreferences)
  }, [])

  return null
}
