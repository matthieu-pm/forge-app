import { useEffect, useState } from "react"
import { useRouter } from "@tanstack/react-router"
import { Button } from "@/components/ui/button"
import { authReturnPath } from "@/lib/default-home"
import { loadDefaultHome } from "@/lib/default-home-state"
import {
  getActiveDesktopTab,
  getDesktopTabPath,
  restoreDesktopTabs,
} from "@/lib/desktop-tabs"
import { productStorage } from "@/lib/product-storage"
import { protectedSessionEpoch } from "@/lib/protected-session"

/** Mounted only after the protected workspace's storage has initialized. */
export function DefaultHomeRedirect() {
  const router = useRouter()
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    const epoch = protectedSessionEpoch()
    const location = router.latestLocation
    const current = () =>
      active &&
      epoch === protectedSessionEpoch() &&
      location === router.latestLocation
    async function open() {
      let restored: string | null = null
      if (window.forgeDesktop) {
        try {
          const tabs = restoreDesktopTabs(
            JSON.parse(productStorage.getItem("forge:desktop-tabs") ?? "null")
          )
          const path = authReturnPath(
            getDesktopTabPath(getActiveDesktopTab(tabs))
          )
          if (path) {
            const pathname = decodeURI(
              new URL(path, window.location.origin).pathname
            )
              .replace(/\/+$/, "")
              .toLowerCase()
            if (pathname && !/^\/onboarding(?:\/|$)/.test(pathname))
              restored = path
          }
        } catch {
          /* Malformed saved tabs use the authorized default. */
        }
      }
      const target = restored ?? (await loadDefaultHome())
      if (current()) await router.navigate({ href: target, replace: true })
    }
    void open().catch(() => {
      if (current()) setFailed(true)
    })
    return () => {
      active = false
    }
  }, [router, attempt])
  return (
    <main className="p-6 text-sm" role={failed ? "alert" : "status"}>
      {failed
        ? "Your home view could not be opened. Please retry."
        : "Opening your workspace…"}
      {failed && (
        <Button
          onClick={() => {
            setFailed(false)
            setAttempt((value) => value + 1)
          }}
        >
          Try again
        </Button>
      )}
    </main>
  )
}
