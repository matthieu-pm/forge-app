"use client"

import { useEffect, useState } from "react"

import { getForgeHost } from "@/host/forge-host"

export function useDesktopBrowserAuth() {
  const [supported, setSupported] = useState<boolean | null>(null)

  useEffect(() => {
    if (!window.forgeDesktop) {
      setSupported(false)
      return
    }

    let cancelled = false
    void getForgeHost()
      .getRuntime()
      .then((runtime) => {
        if (!cancelled) {
          setSupported(runtime.capabilities.includes("browser-auth"))
        }
      })
      .catch(() => {
        if (!cancelled) setSupported(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  return supported
}
