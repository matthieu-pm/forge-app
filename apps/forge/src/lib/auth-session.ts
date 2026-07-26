export type DesktopAuthorizationQuery = {
  client_id: "electron"
  state: string
  code_challenge: string
  code_challenge_method: "S256"
}

export function desktopAuthorizationQuery(
  search: string
): DesktopAuthorizationQuery | null {
  const params = new URLSearchParams(search)
  const state = params.get("state")
  const codeChallenge = params.get("code_challenge")

  if (
    params.get("client_id") !== "electron" ||
    !state ||
    !codeChallenge ||
    params.get("code_challenge_method")?.toUpperCase() !== "S256"
  ) {
    return null
  }

  return {
    client_id: "electron",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }
}

export function beginDesktopAuthorizationRedirect(
  search: string,
  ensureElectronRedirect: (options: { timeout: number }) => unknown
) {
  if (!desktopAuthorizationQuery(search)) {
    return false
  }

  ensureElectronRedirect({ timeout: 30_000 })
  return true
}
