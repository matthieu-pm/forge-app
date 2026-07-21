import { electronClient } from "@better-auth/electron/client"
import { storage } from "@better-auth/electron/storage"
import { createAuthClient } from "better-auth/client"
import { desktopAuthScheme } from "./runtime-config"
import type { BrowserWindow } from "electron"

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
        signInURL: new URL("/login?desktop=1", appOrigin),
        storage: storage({
          projectName: "Forge",
          configName: "authentication",
        }),
        storagePrefix: "forge",
        userImageProxy: {
          enabled: true,
          maxSize: 5 * 1024 * 1024,
        },
      }),
    ],
  })

  authClient.setupMain({
    csp: false,
    getWindow,
  })

  return authClient
}
