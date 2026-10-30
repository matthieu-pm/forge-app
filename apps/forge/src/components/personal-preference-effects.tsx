"use client"

import * as React from "react"

import { usePreferenceGroup } from "./account-preference-provider"
import { applyPersonalInterfacePreferences } from "@/lib/personal-preferences"
import { getForgeHost } from "@/host/forge-host"

export function PersonalPreferenceEffects() {
  const { preferences } = usePreferenceGroup("general")
  React.useEffect(() => {
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)")
    const applyPreferences = () => {
      applyPersonalInterfacePreferences(preferences)
      void getForgeHost().setThemeSource(preferences.interfaceTheme)
    }

    applyPreferences()
    colorScheme.addEventListener("change", applyPreferences)
    return () => colorScheme.removeEventListener("change", applyPreferences)
  }, [preferences])

  return null
}
