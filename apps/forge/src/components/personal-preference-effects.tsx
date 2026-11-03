"use client"

import * as React from "react"

import {
  usePreferenceGroup,
  useProtectedIdentity,
} from "./account-preference-provider"
import {
  appearanceChoiceResolved,
  appearanceForAccount,
  readAppearanceCache,
  writeAppearanceCache,
} from "@/lib/appearance"
import { applyPersonalInterfacePreferences } from "@/lib/personal-preferences"
import { getForgeHost } from "@/host/forge-host"

export function PersonalPreferenceEffects() {
  const identity = useProtectedIdentity()
  const sync = usePreferenceGroup("general")
  const preferences = sync.preferences
  const userId = sync.client?.identity.userId ?? identity?.userId ?? null
  const status = sync.client ? sync.status : userId ? "loading" : "signed-out"
  const choice = React.useMemo(
    () =>
      appearanceForAccount({
        userId,
        values: sync.client ? sync.values : null,
        preferences,
        status,
        cached:
          userId && typeof localStorage !== "undefined"
            ? readAppearanceCache(localStorage, userId)
            : null,
      }),
    [preferences, status, sync.client, sync.values, userId]
  )

  const resolved =
    !userId ||
    appearanceChoiceResolved(
      sync.client ? sync.status : status,
      sync.client ? sync.values : null
    )
  React.useEffect(() => {
    const apply = () => {
      applyPersonalInterfacePreferences(
        { ...preferences, ...choice },
        { appearanceOnly: !resolved }
      )
      void getForgeHost().setThemeSource(choice.interfaceTheme)
    }
    apply()
    if (sync.client && userId && resolved) {
      writeAppearanceCache(localStorage, userId, choice)
    }
    if (
      choice.interfaceTheme !== "system" ||
      typeof window.matchMedia !== "function"
    )
      return
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)")
    colorScheme.addEventListener("change", apply)
    return () => colorScheme.removeEventListener("change", apply)
  }, [
    choice,
    preferences,
    resolved,
    sync.client,
    sync.status,
    sync.values,
    userId,
  ])

  return null
}
