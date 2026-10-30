// @vitest-environment node
import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApplicationAccessError } from "../authorization"
import { FileDeliveryService } from "./file-delivery-service.server"
import { createFileDeliveryHttpHandler } from "./file-delivery-http.server"
import { fileChecksum } from "./file-integrity.server"
import { mintFileGrant, verifyFileGrant } from "./file-grant.server"
import {
  downloadFileResponse,
  previewFileResponse,
} from "./file-response.server"
import { readBoundedFile } from "./bounded-file-read.server"
import type { Actor } from "../actor"
import type { FileTarget } from "./file-delivery-contract"

vi.mock("@tanstack/react-start/server-only", () => ({}))
afterEach(() => vi.unstubAllEnvs())
function fixture() {
  vi.stubEnv(
    "FORGE_AGENT_ARTIFACT_SECRET",
    "for36-fixture-signing-secret-at-least-32-characters"
  )
  const actor: Actor = {
    workspaceId: "workspace-a",
    userId: "alice",
    workspaceRole: "member",
    authentication: { kind: "session", sessionId: "session" },
    scopes: null,
  }
  const target: FileTarget = { kind: "resources", id: randomUUID() }
  const content = new TextEncoder().encode("private file\n")
  const file = {
    id: target.id,
    storageReference: `files/${randomUUID()}`,
    name: "private.txt",
    contentType: "text/plain",
    sizeBytes: content.byteLength,
    checksum: fileChecksum(content),
  }
  let authorized = true,
    now = new Date("2026-10-30T11:00:00Z"),
    active = actor
  const lookup = vi.fn(async (who: Actor) =>
    authorized &&
    who.workspaceId === actor.workspaceId &&
    who.userId === actor.userId
      ? file
      : null
  )
  const blobs = {
    put: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(async () => content),
  }
  const service = new FileDeliveryService({ lookup, blobs, now: () => now })
  const handler = createFileDeliveryHttpHandler({
    getActor: async () => active,
    service,
  })
  return {
    actor,
    target,
    file,
    content,
    lookup,
    blobs,
    service,
    handler,
    revoke: () => {
      authorized = false
    },
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
    useActor: (a: Actor) => {
      active = a
    },
  }
}
describe("FOR-36 authorized file delivery", () => {
  it.each(["resources", "artifacts", "attachments"] as const)(
    "issues bounded %s grants and streams exact bytes with safe headers",
    async (kind) => {
      const f = fixture(),
        target = { ...f.target, kind }
      const grant = await f.service.grant(f.actor, target, "download")
      expect(grant.expiresInSeconds).toBe(300)
      expect(JSON.stringify(grant)).not.toContain("storageReference")
      expect(f.blobs.get).not.toHaveBeenCalled()
      const response = await f.handler(
        new Request(`http://forge.test${grant.url}`)
      )
      expect(response.status).toBe(200)
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(f.content)
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream"
      )
      expect(response.headers.get("content-disposition")).toMatch(
        /^attachment;/
      )
      expect(response.headers.get("cache-control")).toContain("no-store")
      expect(response.headers.get("referrer-policy")).toBe("no-referrer")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }
  )
  it("denies a grant after revocation without accessing private storage", async () => {
    const f = fixture(),
      grant = await f.service.grant(f.actor, f.target, "download")
    f.revoke()
    expect(
      (await f.handler(new Request(`http://forge.test${grant.url}`))).status
    ).toBe(404)
    expect(f.blobs.get).not.toHaveBeenCalled()
    await expect(
      f.service.grant(f.actor, f.target, "download")
    ).rejects.toThrow("no longer have access")
  })
  it("rechecks access after storage awaits before exposing any bytes", async () => {
    const f = fixture(),
      grant = await f.service.grant(f.actor, f.target, "download")
    f.blobs.get.mockImplementationOnce(async () => {
      f.revoke()
      return f.content
    })
    const response = await f.handler(
      new Request(`http://forge.test${grant.url}`)
    )
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain("private file")
  })
  it.each(["user", "workspace", "file", "kind", "purpose"])(
    "rejects a grant replay for another %s",
    async (changed) => {
      const f = fixture(),
        grant = await f.service.grant(f.actor, f.target, "download")
      const token = new URL(grant.url, "http://forge.test").searchParams.get(
        "token"
      )!
      const actor = {
        ...f.actor,
        ...(changed === "user"
          ? { userId: "bob" }
          : changed === "workspace"
            ? { workspaceId: "other" }
            : {}),
      }
      const target = {
        ...f.target,
        ...(changed === "file"
          ? { id: randomUUID() }
          : changed === "kind"
            ? { kind: "artifacts" as const }
            : {}),
      }
      await expect(
        f.service.read(
          actor,
          target,
          changed === "purpose" ? "preview" : "download",
          token
        )
      ).rejects.toThrow("invalid or expired")
      expect(f.blobs.get).not.toHaveBeenCalled()
    }
  )
  it("rejects expired grants exactly at five minutes and tampered grants", async () => {
    const f = fixture(),
      grant = await f.service.grant(f.actor, f.target, "download")
    const url = `http://forge.test${grant.url}`
    expect((await f.handler(new Request(url + "tampered"))).status).toBe(403)
    f.advance(300_000)
    expect((await f.handler(new Request(url))).status).toBe(403)
    expect(f.blobs.get).not.toHaveBeenCalled()
  })
  it("fails closed on corrupt/missing bytes and redacts storage failures", async () => {
    const f = fixture(),
      grant = await f.service.grant(f.actor, f.target, "download")
    f.blobs.get.mockResolvedValueOnce(new Uint8Array([1]))
    expect(
      (await f.handler(new Request(`http://forge.test${grant.url}`))).status
    ).toBe(503)
    f.blobs.get.mockRejectedValueOnce(
      new Error("secret-token storage-reference")
    )
    const response = await f.handler(
      new Request(`http://forge.test${grant.url}`)
    )
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain("secret-token")
  })
  it("refuses previews above 1 MB before storage I/O while retaining downloads", async () => {
    const f = fixture()
    f.file.sizeBytes = 1_000_001
    await expect(f.service.grant(f.actor, f.target, "preview")).rejects.toThrow(
      "preview is unavailable"
    )
    await expect(
      f.service.grant(f.actor, f.target, "download")
    ).resolves.toHaveProperty("url")
    expect(f.blobs.get).not.toHaveBeenCalled()
  })
  it("rejects cross-origin and malformed grant requests before delivery", async () => {
    const f = fixture(),
      path = `http://forge.test/api/files/resources/${f.target.id}/grant`
    for (const headers of [{}, { origin: "http://evil.test" }] as Array<
      Record<string, string>
    >) {
      expect(
        (
          await f.handler(
            new Request(path, {
              method: "POST",
              headers,
              body: JSON.stringify({ purpose: "download" }),
            })
          )
        ).status
      ).toBe(404)
    }
    expect(
      (
        await f.handler(
          new Request(path, {
            method: "POST",
            headers: { origin: "http://forge.test" },
            body: JSON.stringify({
              purpose: "download",
              storageReference: "arbitrary",
            }),
          })
        )
      ).status
    ).toBe(400)
    const grant = await f.handler(
      new Request(path, {
        method: "POST",
        headers: { origin: "http://forge.test" },
        body: JSON.stringify({ purpose: "download" }),
      })
    )
    expect(grant.status).toBe(200)
    expect(f.blobs.get).not.toHaveBeenCalled()
  })
  it("does not accept API or agent credentials at the first-party file endpoint", async () => {
    const f = fixture()
    await expect(
      f.service.grant(
        {
          ...f.actor,
          authentication: { kind: "agent", runId: randomUUID() },
        } as Actor,
        f.target,
        "download"
      )
    ).rejects.toThrow()
  })
  it("handles denied current-session resolution without exposing metadata", async () => {
    const f = fixture()
    const handler = createFileDeliveryHttpHandler({
      service: f.service,
      getActor: async () => {
        throw new ApplicationAccessError()
      },
    })
    expect(
      (
        await handler(
          new Request(
            `http://forge.test/api/files/resources/${f.target.id}/preview?token=${"x".repeat(30)}`
          )
        )
      ).status
    ).toBe(404)
    expect(f.lookup).not.toHaveBeenCalled()
  })
  it("binds grants to five minutes independently of JWT decoding", async () => {
    const f = fixture(),
      now = new Date()
    const token = await mintFileGrant(f.actor, f.target, "preview", now)
    await expect(
      verifyFileGrant(
        token,
        f.actor,
        f.target,
        "preview",
        new Date(now.getTime() + 300_000)
      )
    ).rejects.toThrow()
  })
})

describe("bounded, inert file rendering", () => {
  it("removes HTML scripts, URLs, navigation, forms and embedded documents", async () => {
    const content = `<h1>Readable</h1><script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://evil.test"><a href="https://evil.test">link</a><form action="/api/auth"><input></form><iframe srcdoc="<script>alert(1)</script>"></iframe><style>body{background:url(https://evil.test)}</style><img src="https://evil.test"><p style="background:url(https://evil.test)" onclick="alert(1)">safe</p>`
    const response = previewFileResponse(
      { name: "x.html", contentType: "text/html" },
      new TextEncoder().encode(content)
    )
    const html = await response.text()
    expect(html).toContain("<h1>Readable</h1>")
    expect(html).not.toMatch(
      /<script|<form|<iframe|<input|<a |onclick|evil\.test|http-equiv/
    )
    expect(response.headers.get("content-security-policy")).toContain(
      "sandbox;"
    )
    expect(response.headers.get("content-security-policy")).not.toContain(
      "allow-scripts"
    )
    expect(response.headers.get("content-security-policy")).not.toContain(
      "allow-same-origin"
    )
  })
  it("renders SVG only in image mode after stripping executable/URL-bearing markup", async () => {
    const source = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><script>alert(1)</script><foreignObject><iframe src="https://evil.test"/></foreignObject><use href="https://evil.test/a.svg#x"/><rect width="30" height="30" fill="url(https://evil.test)" onload="alert(1)"/></svg>`
    const html = await previewFileResponse(
      { name: "x.svg", contentType: "image/svg+xml" },
      new TextEncoder().encode(source)
    ).text()
    const svg = Buffer.from(
      html.match(/data:image\/svg\+xml;base64,([^"]+)/)![1],
      "base64"
    ).toString()
    expect(svg).toContain('viewBox="0 0 100 100"')
    expect(svg).not.toMatch(
      /script|foreignObject|iframe|href|onload|evil\.test/
    )
  })
  it("escapes text and refuses binary/office/PDF extraction and invalid UTF-8", async () => {
    expect(
      await previewFileResponse(
        { name: "x.txt", contentType: "text/plain" },
        new TextEncoder().encode("<script>alert(1)</script>")
      ).text()
    ).toContain("&lt;script&gt;")
    for (const contentType of [
      "application/pdf",
      "application/zip",
      "application/octet-stream",
    ])
      expect(() =>
        previewFileResponse({ name: "x", contentType }, new Uint8Array([65]))
      ).toThrow("preview is unavailable")
    expect(() =>
      previewFileResponse(
        { name: "x.txt", contentType: "text/plain" },
        new Uint8Array([255])
      )
    ).toThrow()
  })
  it("streams large downloads exactly and encodes hostile legacy filenames", async () => {
    const bytes = new Uint8Array(5 * 1024 * 1024).fill(65)
    const response = downloadFileResponse(
      { name: "a'\r\nX-Header:\ud800.html" },
      bytes
    )
    expect(response.headers.get("content-disposition")).not.toContain("\r\n")
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream"
    )
    expect(
      Buffer.from(await response.arrayBuffer()).equals(Buffer.from(bytes))
    ).toBe(true)
  })
  it("cancels oversized upstream streams instead of buffering them", async () => {
    const cancel = vi.fn()
    await expect(
      readBoundedFile(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(4))
            c.enqueue(new Uint8Array(4))
          },
          cancel,
        }),
        5
      )
    ).rejects.toThrow("read bound")
    expect(cancel).toHaveBeenCalled()
  })
  it("cancels a stalled upstream read on timeout", async () => {
    const cancel = vi.fn()
    await expect(
      readBoundedFile(
        new ReadableStream({ cancel }),
        5,
        AbortSignal.timeout(10)
      )
    ).rejects.toThrow()
    expect(cancel).toHaveBeenCalled()
  })
})
