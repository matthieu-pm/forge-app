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
        return
      }

      if (event.type === "auth-ready") {
        void host
          .adoptAuthSession()
          .then(({ returnTo }) => {
            window.location.replace(returnTo)
          })
          .catch((error: unknown) => {
            toast.error(
              error instanceof Error
                ? error.message
                : "Forge could not finish signing you in."
            )
          })
        return
      }

      if (event.type === "auth-session-adopted") {
        window.location.replace(event.returnTo)
        return
      }

      if (event.type === "auth-signed-out") {
        window.location.replace("/login")
        return
      }

      if (event.type === "auth-error") {
        toast.error(event.message)
      }
    })
  }, [router])

  return null
}
