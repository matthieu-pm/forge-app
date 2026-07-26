import type { HostRuntime } from "./forge-host"

export function resolveHostPlatform(
  runtimePlatform: HostRuntime["platform"],
  userAgent: string
): HostRuntime["platform"] {
  if (runtimePlatform !== "web" || !userAgent.includes("Electron/")) {
    return runtimePlatform
  }

  if (/Macintosh|Mac OS X/.test(userAgent)) {
    return "macos"
  }

  if (/Windows/.test(userAgent)) {
    return "windows"
  }

  return runtimePlatform
}
