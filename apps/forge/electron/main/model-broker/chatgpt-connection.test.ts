// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { exchangeChatGPTToken } from "../../../shared/chatgpt-oauth"
import {
  ChatGPTConnection,
  callbackClientId,
  parseChatGPTModels,
} from "./chatgpt-connection"

const electron = vi.hoisted(() => ({
  openExternal: vi.fn(),
  encryptString: vi.fn((text: string) =>
    Buffer.from(text).map((byte) => byte ^ 42)
  ),
  decryptString: vi.fn((bytes: Buffer) =>
    Buffer.from(bytes)
      .map((byte) => byte ^ 42)
      .toString()
  ),
}))
vi.mock("electron", () => ({
  shell: { openExternal: electron.openExternal },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptString: electron.encryptString,
    decryptString: electron.decryptString,
  },
}))
vi.mock("../../../shared/chatgpt-oauth", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  chatGPTDiscovery: async () => ({
    authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
  }),
  exchangeChatGPTToken: vi.fn(),
  verifyChatGPTIdentity: async () => ({
    subject: "subject",
    email: "person@example.test",
  }),
}))
const dirs: Array<string> = []
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.mocked(exchangeChatGPTToken).mockReset()
  electron.openExternal.mockReset()
})
async function connection() {
  const dir = await mkdtemp(join(tmpdir(), "forge-chatgpt-test-"))
  dirs.push(dir)
  return { dir, account: new ChatGPTConnection(dir) }
}
function authorize() {
  electron.openExternal.mockImplementation(async (input: string) => {
    const auth = new URL(input)
    const callback = new URL(auth.searchParams.get("redirect_uri")!)
    callback.search = new URLSearchParams({
      state: auth.searchParams.get("state")!,
      code: "code",
      client_id: "oaiapp_forge",
    }).toString()
    await fetch(callback)
  })
  vi.mocked(exchangeChatGPTToken).mockResolvedValue({
    id_token: "private-id",
    access_token: "private-access",
    refresh_token: "private-refresh",
    expires_in: 3600,
    scope: "openid chatgpt.tokens.use.direct",
  })
}
describe("ChatGPT plan connection", () => {
  it("rejects mismatched state, missing registration, changed client and declined consent", () => {
    for (const params of [
      "state=wrong&code=code&client_id=oaiapp_forge",
      "state=state&code=code",
      "state=state&code=code&client_id=dynamic_agent_client",
      "state=state&error=access_denied",
    ]) {
      expect(() =>
        callbackClientId(new URLSearchParams(params), "state")
      ).toThrow()
    }
    expect(() =>
      callbackClientId(
        new URLSearchParams("state=state&code=code&client_id=oaiapp_other"),
        "state",
        "oaiapp_forge"
      )
    ).toThrow()
    expect(
      callbackClientId(
        new URLSearchParams("state=state&code=code"),
        "state",
        "oaiapp_forge"
      )
    ).toBe("oaiapp_forge")
  })
  it("keeps account ordering, slugs and visibility from the live catalog", () => {
    expect(
      parseChatGPTModels({
        models: [
          { slug: "model-b", display_name: "Second", visibility: "list" },
          { slug: "hidden", display_name: "Hidden", visibility: "hide" },
          { slug: "model-a", display_name: "First", visibility: "list" },
        ],
      }).map((model) => model.id)
    ).toEqual(["model-b", "model-a"])
    expect(() =>
      parseChatGPTModels({ data: [{ id: "api-key-model" }] })
    ).toThrow()
  })
  it("exchanges a loopback code, encrypts locally, and reuses the registration", async () => {
    authorize()
    const { dir, account } = await connection()
    expect(await account.login()).toEqual({ type: "chatgpt", connected: true })
    const auth = new URL(electron.openExternal.mock.calls[0][0])
    expect(auth.searchParams.get("client_id")).toBe("dynamic_agent_client")
    expect(auth.searchParams.get("agent_name_hint")).toBe("Forge")
    const exchange = vi.mocked(exchangeChatGPTToken).mock.calls[0][0]
    expect(exchange.get("client_id")).toBe("oaiapp_forge")
    expect(exchange.get("redirect_uri")).toBe(
      auth.searchParams.get("redirect_uri")
    )
    const path = join(dir, "chatgpt", "account.enc")
    expect((await readFile(path)).toString()).not.toContain("private-access")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await account.accessToken()).toBe("private-access")
    await account.login()
    const returning = new URL(electron.openExternal.mock.calls[1][0])
    expect(returning.searchParams.get("client_id")).toBe("oaiapp_forge")
    expect(returning.searchParams.get("ext_agent_host_id")).toBe(
      auth.searchParams.get("ext_agent_host_id")
    )
    expect(returning.searchParams.has("agent_name_hint")).toBe(false)
  })
  it("serializes refreshes and persists the rotated refresh token", async () => {
    authorize()
    vi.mocked(exchangeChatGPTToken).mockResolvedValueOnce({
      id_token: "private-id",
      access_token: "old",
      refresh_token: "old-refresh",
      expires_in: 1,
      scope: "chatgpt.tokens.use.direct",
    })
    const { account } = await connection()
    await account.login()
    vi.mocked(exchangeChatGPTToken).mockResolvedValue({
      access_token: "new",
      refresh_token: "new-refresh",
      expires_in: 3600,
    })
    expect(
      await Promise.all([account.accessToken(), account.accessToken()])
    ).toEqual(["new", "new"])
    expect(exchangeChatGPTToken).toHaveBeenCalledTimes(2)
    expect(
      vi.mocked(exchangeChatGPTToken).mock.calls[1][0].get("grant_type")
    ).toBe("refresh_token")
  })
  it("does not expose models for identity-only consent", async () => {
    authorize()
    vi.mocked(exchangeChatGPTToken).mockResolvedValue({
      id_token: "private-id",
      access_token: "private-access",
      expires_in: 3600,
      scope: "openid email",
    })
    const { account } = await connection()
    await expect(account.login()).rejects.toThrow("allow ChatGPT plan usage")
    await expect(account.accessToken()).rejects.toThrow("allow plan usage")
  })
})
