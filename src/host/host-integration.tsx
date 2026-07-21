"use client"

import { useEffect } from "react"
import { useRouter } from "@tanstack/react-router"
import { toast } from "sonner"

import { getForgeHost } from "./forge-host"
import { resolveHostPlatform } from "./host-platform"

export function HostIntegration() {
  const router = useRouter()

  useEffect(() => {
    const host = getForgeHost()
    const userAgent = navigator.userAgent

    document.documentElement.dataset.forgeHost = resolveHostPlatform(
      "web",
      userAgent
    )

    void host.getRuntime().then((runtime) => {
      document.documentElement.dataset.forgeHost = resolveHostPlatform(
        runtime.platform,
        userAgent
      )
    })

    return host.subscribe((event) => {
      if (event.type === "navigate") {
        void router.navigate({ href: event.path })
        return
      }

      if (event.type === "command" && event.command === "open-preferences") {
        void router.navigate({ href: "/settings" })
        return
      }

      if (event.type === "update-ready") {
        toast.info(`Forge ${event.version} is ready to install.`)
      }
    })
  }, [router])

  return null
}
