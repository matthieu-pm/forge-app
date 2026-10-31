// @vitest-environment node
import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { put } from "@vercel/blob/client"
import { uploadFileDirect } from "./direct-upload-client"

vi.mock("@vercel/blob/client", () => ({ put: vi.fn(async () => ({})) }))
const id = "70000000-0000-4000-8000-000000000001"
function fixture() {
  const file = new Blob([Buffer.alloc(5 * 1024 * 1024, 65)], {
    type: "text/plain",
  })
  const input = {
    name: "large.txt",
    contentType: "text/plain",
    file,
    target: { kind: "agent" as const },
  }
  const ready = {
    id,
    name: input.name,
    contentType: "text/plain",
    sizeBytes: file.size,
    checksum: createHash("sha256")
      .update(Buffer.alloc(file.size, 65))
      .digest("hex"),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  }
  const calls: Array<{ url: string; body: unknown }> = []
  let loseFinalize = false
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body })
    if (String(url).endsWith("/token"))
      return Response.json({
        state: "pending",
        upload: {
          adapter: "vercel-private",
          pathname: `forge/files/${id}`,
          token: "scoped-upload-token",
          maximumSizeInBytes: file.size,
          validUntil: Date.now() + 600000,
        },
      })
    if (String(url).endsWith("/finalize")) {
      if (loseFinalize) {
        loseFinalize = false
        throw new Error("Connection lost after commit")
      }
      return Response.json(ready)
    }
    return Response.json({ id, state: "pending", result: null })
  }) as unknown as typeof fetch
  return {
    input,
    ready,
    calls,
    fetcher,
    loseNextFinalize() {
      loseFinalize = true
    },
  }
}
describe("direct upload browser transport", () => {
  it("sends 5 MiB bytes to the storage SDK and only small metadata to application routes", async () => {
    const f = fixture()
    expect(await uploadFileDirect(f.input, f.fetcher)).toEqual(f.ready)
    expect(put).toHaveBeenCalledWith(
      expect.any(String),
      f.input.file,
      expect.objectContaining({
        access: "private",
        contentType: "application/octet-stream",
      })
    )
    expect(
      f.calls.every((c) => typeof c.body === "string" && c.body.length < 8192)
    ).toBe(true)
    expect(f.calls.some((c) => String(c.body).includes("contentBase64"))).toBe(
      false
    )
  })
  it("recovers a lost finalize response with the same intent and no second byte upload", async () => {
    const f = fixture(),
      sessions = new Map()
    f.loseNextFinalize()
    await expect(
      uploadFileDirect(f.input, f.fetcher, sessions)
    ).rejects.toThrow("Connection lost")
    expect(await uploadFileDirect(f.input, f.fetcher, sessions)).toEqual(
      f.ready
    )
    expect(f.calls.filter((c) => c.url === "/api/files/uploads/")).toHaveLength(
      1
    )
    expect(put).toHaveBeenCalledOnce()
    expect(sessions.size).toBe(0)
  })
})

it("rejects an identity change during file reading before any HTTP or provider upload", async () => {
  const f = fixture()
  let active = true
  const original = f.input.file.arrayBuffer.bind(f.input.file)
  vi.spyOn(f.input.file, "arrayBuffer").mockImplementation(async () => {
    const bytes = await original()
    active = false
    return bytes
  })
  const providerCalls = vi.mocked(put).mock.calls.length
  await expect(
    uploadFileDirect(f.input, f.fetcher, new Map(), {
      assertCurrent() {
        if (!active) throw new Error("Session changed")
      },
    })
  ).rejects.toThrow("Session changed")
  expect(f.fetcher).not.toHaveBeenCalled()
  expect(vi.mocked(put).mock.calls.length).toBe(providerCalls)
})
it("binds every metadata request to the expected session and stops before bytes on an identity change", async () => {
  const f = fixture(),
    headers = {
      "x-forge-upload-session": "alice",
      "x-forge-upload-workspace": "workspace",
    }
  let current = true
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("x-forge-upload-session")).toBe(
      "alice"
    )
    const response = await f.fetcher(url, init)
    if (String(url).endsWith("/token")) current = false
    return response
  }) as unknown as typeof fetch
  const providerCalls = vi.mocked(put).mock.calls.length
  await expect(
    uploadFileDirect(f.input, fetcher, new Map(), {
      headers,
      assertCurrent() {
        if (!current) throw new Error("Session changed")
      },
    })
  ).rejects.toThrow("Session changed")
  expect(vi.mocked(put).mock.calls.length).toBe(providerCalls)
})
