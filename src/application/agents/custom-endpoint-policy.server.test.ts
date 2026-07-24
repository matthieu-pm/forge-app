// @vitest-environment node

import { describe, expect, it, vi } from "vitest"

import {
  createPinnedEndpointLookup,
  isPrivateAddress,
} from "@/application/agents/custom-endpoint-policy.server"

describe("custom endpoint network policy", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:127.0.0.1",
  ])("blocks private or special address %s", (address) => {
    expect(isPrivateAddress(address)).toBe(true)
  })

  it.each(["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => {
      expect(isPrivateAddress(address)).toBe(false)
    }
  )

  it("pins custom endpoint connections to the previously validated addresses", () => {
    const lookup = createPinnedEndpointLookup([
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ])
    const callback = vi.fn()
    lookup("provider.example", { all: true }, callback)

    expect(callback).toHaveBeenCalledWith(null, [
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ])
  })
})
