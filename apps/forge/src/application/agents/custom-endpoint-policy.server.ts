import "@tanstack/react-start/server-only"

import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map(Number)
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return true
  }
  const [a, b, c] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  )
}

function isPrivateIpv6(address: string) {
  const normalized = address.toLowerCase()
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("fec") ||
    normalized.startsWith("fed") ||
    normalized.startsWith("fee") ||
    normalized.startsWith("fef") ||
    normalized.startsWith("ff") ||
    normalized.startsWith("2001:db8:") ||
    normalized.startsWith("::ffff:")
  )
}

export function isPrivateAddress(address: string) {
  const family = isIP(address)
  return family === 4
    ? isPrivateIpv4(address)
    : family === 6
      ? isPrivateIpv6(address)
      : true
}

export async function validateServerProviderEndpoint(value: string) {
  return (await resolveServerProviderEndpoint(value)).url
}

export type PublicEndpointAddress = {
  address: string
  family: 4 | 6
}

type LookupCallback = (
  error: Error | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number
) => void

export function createPinnedEndpointLookup(
  addresses: ReadonlyArray<PublicEndpointAddress>
) {
  if (addresses.length === 0) {
    throw new Error("A pinned endpoint requires at least one address.")
  }
  let cursor = 0
  return (
    _hostname: string,
    options: { all?: boolean } | number,
    callback: LookupCallback
  ) => {
    if (typeof options === "object" && options.all) {
      callback(
        null,
        addresses.map((entry) => ({
          address: entry.address,
          family: entry.family,
        }))
      )
      return
    }
    const selected = addresses[cursor % addresses.length]
    cursor += 1
    callback(null, selected.address, selected.family)
  }
}

export async function resolveServerProviderEndpoint(value: string) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error(
      "Custom server providers require an HTTPS URL without credentials or a custom port."
    )
  }
  if (url.pathname !== "/" && !url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`
  }
  url.search = ""
  url.hash = ""

  const records = await lookup(url.hostname, { all: true, verbatim: true })
  if (
    records.length === 0 ||
    records.some((record) => isPrivateAddress(record.address))
  ) {
    throw new Error(
      "Custom provider endpoints must resolve only to public network addresses."
    )
  }
  return {
    url,
    addresses: records.map((record) => ({
      address: record.address,
      family: record.family,
    })) as Array<PublicEndpointAddress>,
  }
}
