import { app, session } from "electron"

function isTrustedOrigin(value: string, appOrigin: string) {
  try {
    return new URL(value).origin === new URL(appOrigin).origin
  } catch {
    return false
  }
}

export function configureSessionSecurity(appOrigin: string) {
  const forgeSession = session.defaultSession

  forgeSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin) =>
      Boolean(webContents) &&
      permission === "notifications" &&
      isTrustedOrigin(requestingOrigin, appOrigin)
  )

  forgeSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        permission === "notifications" &&
          isTrustedOrigin(details.requestingUrl, appOrigin) &&
          isTrustedOrigin(webContents.getURL(), appOrigin)
      )
    }
  )

  if (app.isPackaged) {
    forgeSession.webRequest.onHeadersReceived((details, callback) => {
      if (!isTrustedOrigin(details.url, appOrigin)) {
        callback({ responseHeaders: details.responseHeaders })
        return
      }

      const headers = { ...details.responseHeaders }
      const hasCsp = Object.keys(headers).some(
        (name) => name.toLowerCase() === "content-security-policy"
      )

      if (!hasCsp) {
        headers["Content-Security-Policy"] = [
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
        ]
      }

      callback({ responseHeaders: headers })
    })
  }
}
