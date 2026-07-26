import { electronClient } from "@better-auth/electron/client"
import { storage } from "@better-auth/electron/storage"
import { createAuthClient } from "better-auth/client"
import { BrowserWindow } from "electron"

import { desktopAuthScheme } from "./runtime-config"
import { replaceRendererAuthCookies } from "./auth-cookies"
import type { Session } from "electron"

type PendingAuthorization = {
  returnTo: string
  windowId: number
}

const electronAuthorizationState = Symbol.for("better-auth:electron")

export function setupDesktopAuth(
  appOrigin: string,
  getWindow: () => BrowserWindow | null
) {
  const authClient = createAuthClient({
    baseURL: appOrigin,
    plugins: [
      electronClient({
        protocol: {
          scheme: desktopAuthScheme,
        },
        signInURL: new URL("/auth/desktop", appOrigin),
        storage: storage({
          projectName: "Forge",
          configName: "authentication",
        }),
        storagePrefix: "forge",
        sanitizeUser: (user) => ({
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified,
          image: user.image,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
        }),
        userImageProxy: {
          enabled: true,
          maxSize: 5 * 1024 * 1024,
        },
      }),
    ],
  })

  let pendingAuthorization: PendingAuthorization | null = null

  const getAuthorizationWindow = () => {
    if (pendingAuthorization) {
      const pendingWindow = BrowserWindow.fromId(pendingAuthorization.windowId)
      if (pendingWindow && !pendingWindow.isDestroyed()) {
        return pendingWindow
      }
    }

    return getWindow()
  }

  authClient.setupMain({
    csp: false,
    getWindow: getAuthorizationWindow,
  })

  return {
    async begin(window: BrowserWindow, returnTo = "/inbox") {
      const authorizationState = Reflect.get(
        globalThis,
        electronAuthorizationState
      ) as Map<string, string> | undefined
      authorizationState?.clear()

      pendingAuthorization = {
        returnTo,
        windowId: window.id,
      }

      try {
        await authClient.requestAuth()
      } catch (error) {
        pendingAuthorization = null
        throw error
      }
    },

    async adopt(electronSession: Session, window: BrowserWindow) {
      const sessionResult = await authClient.getSession()
      if (sessionResult.error || !sessionResult.data?.session) {
        throw new Error("The desktop authentication session is not valid.")
      }

      const adoptedCookieCount = await replaceRendererAuthCookies(
        electronSession,
        appOrigin,
        authClient.getCookie()
      )

      if (adoptedCookieCount === 0) {
        throw new Error("Forge did not receive an authentication session.")
      }

      const returnTo =
        pendingAuthorization?.windowId === window.id
          ? pendingAuthorization.returnTo
          : "/inbox"
      pendingAuthorization = null

      return { returnTo }
    },

    async complete(token: string) {
      await authClient.authenticate({ token })
    },

    async restore(electronSession: Session) {
      const cookieHeader = authClient.getCookie()
      if (!cookieHeader) return false

      return (
        (await replaceRendererAuthCookies(
          electronSession,
          appOrigin,
          cookieHeader
        )) > 0
      )
    },

    async signOut(electronSession: Session) {
      try {
        await authClient.signOut()
      } catch {
        // Local session removal must still succeed when the server is offline or
        // the renderer already revoked the shared session.
      } finally {
        pendingAuthorization = null
        await replaceRendererAuthCookies(electronSession, appOrigin, "")
      }
    },
  }
}

export type DesktopAuth = ReturnType<typeof setupDesktopAuth>
