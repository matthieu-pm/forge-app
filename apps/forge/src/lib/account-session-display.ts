import { formatDistanceToNow } from "date-fns"

export function accountSessionDevice(userAgent: string | null | undefined) {
  const agent = userAgent ?? ""
  const platform = /android/i.test(agent)
    ? "Android"
    : /iphone|ipad/i.test(agent)
      ? "iOS"
      : /macintosh|mac os/i.test(agent)
        ? "macOS"
        : /windows/i.test(agent)
          ? "Windows"
          : /linux/i.test(agent)
            ? "Linux"
            : null
  const client = /electron|forge-desktop/i.test(agent)
    ? "Forge Desktop"
    : /edg\//i.test(agent)
      ? "Edge"
      : /opr\//i.test(agent)
        ? "Opera"
        : /firefox\//i.test(agent)
          ? "Firefox"
          : /chrome|crios/i.test(agent)
            ? "Chrome"
            : /safari/i.test(agent)
              ? "Safari"
              : "Browser"
  return {
    name: platform ? `${client} on ${platform}` : client,
    desktop: client === "Forge Desktop",
  }
}

export function accountSessionLastSeen(value: Date | string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? "Last seen unavailable"
    : `Last seen ${formatDistanceToNow(date, { addSuffix: true })}`
}
