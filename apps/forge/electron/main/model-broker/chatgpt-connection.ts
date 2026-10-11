import { randomBytes, randomUUID } from "node:crypto"
import { createServer } from "node:http"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { safeStorage, shell } from "electron"
import { z } from "zod"
import {
  CHATGPT_PLAN_SCOPE,
  CHATGPT_RESOURCE,
  CHATGPT_SCOPES,
  chatGPTDiscovery,
  exchangeChatGPTToken,
  pkceChallenge,
  verifyChatGPTIdentity,
} from "../../../shared/chatgpt-oauth"

const profileSchema = z.object({
  clientId: z.string().startsWith("oaiapp_"),
  subject: z.string(),
  email: z.string().nullable(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  idToken: z.string(),
  expiresAt: z.number(),
  scopes: z.array(z.string()),
})
type Profile = z.infer<typeof profileSchema>
export const chatGPTCatalogSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      display_name: z.string().min(1),
      visibility: z.string(),
      supported_reasoning_levels: z
        .array(z.object({ effort: z.string() }))
        .optional(),
      context_window: z.number().positive().optional(),
    })
  ),
})
export function parseChatGPTModels(value: unknown) {
  return chatGPTCatalogSchema
    .parse(value)
    .models.filter((model) => model.visibility === "list")
    .map((model) => ({
      id: model.slug,
      displayName: model.display_name,
      supportedReasoningEfforts:
        model.supported_reasoning_levels?.map((level) => level.effort) ?? [],
      contextWindowTokens: model.context_window ?? null,
    }))
}
export function callbackClientId(
  params: URLSearchParams,
  expectedState: string,
  existingClientId?: string
) {
  if (params.get("state") !== expectedState)
    throw new Error("ChatGPT sign-in could not be verified.")
  if (params.has("error"))
    throw new Error("ChatGPT sign-in was cancelled or declined.")
  const clientId = params.get("client_id") ?? existingClientId
  if (
    !clientId?.startsWith("oaiapp_") ||
    (existingClientId && clientId !== existingClientId) ||
    !params.get("code")
  ) {
    throw new Error("ChatGPT registration is incomplete. Please try again.")
  }
  return clientId
}

export class ChatGPTConnection {
  #refresh: Promise<Profile> | null = null
  #login: Promise<{ type: "chatgpt"; connected: true }> | null = null
  #cancelLogin: (() => void) | null = null
  readonly #directory: string
  constructor(userDataPath: string) {
    this.#directory = join(userDataPath, "chatgpt")
  }
  async #write(name: string, content: string | Buffer) {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const target = join(this.#directory, name)
    const temp = `${target}.${randomUUID()}.tmp`
    await writeFile(temp, content, { mode: 0o600, flag: "wx" })
    await rename(temp, target)
  }
  async #read(): Promise<Profile | null> {
    try {
      const bytes = await readFile(join(this.#directory, "account.enc"))
      if (!safeStorage.isEncryptionAvailable())
        throw new Error("Secure ChatGPT storage is unavailable.")
      return profileSchema.parse(JSON.parse(safeStorage.decryptString(bytes)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw new Error(
        "ChatGPT credentials could not be read from secure local storage."
      )
    }
  }
  async #save(profile: Profile) {
    if (
      !safeStorage.isEncryptionAvailable() ||
      safeStorage.getSelectedStorageBackend?.() === "basic_text"
    ) {
      throw new Error("Secure ChatGPT storage is unavailable on this device.")
    }
    await this.#write(
      "account.enc",
      safeStorage.encryptString(JSON.stringify(profile))
    )
  }
  async #registration() {
    try {
      return z
        .string()
        .startsWith("oaiapp_")
        .parse(await readFile(join(this.#directory, "client-id"), "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }
  async #hostId() {
    try {
      return z
        .string()
        .regex(/^urn:uuid:[a-f0-9-]{36}$/)
        .parse(await readFile(join(this.#directory, "host-id"), "utf8"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const id = `urn:uuid:${randomUUID()}`
    await this.#write("host-id", id)
    return id
  }
  async profile() {
    const profile = await this.#read()
    return profile
      ? {
          email: profile.email,
          planEnabled: profile.scopes.includes(CHATGPT_PLAN_SCOPE),
        }
      : null
  }
  async accessToken() {
    let profile = await this.#read()
    if (!profile || !profile.scopes.includes(CHATGPT_PLAN_SCOPE))
      throw new Error(
        "Continue with ChatGPT and allow plan usage to use models."
      )
    if (profile.expiresAt <= Date.now() + 60_000) {
      this.#refresh ??= this.#renew(profile).finally(() => {
        this.#refresh = null
      })
      profile = await this.#refresh
    }
    return profile.accessToken
  }
  async #renew(profile: Profile) {
    if (!profile.refreshToken)
      throw new Error("Continue with ChatGPT again to reconnect your plan.")
    const tokens = await exchangeChatGPTToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: profile.clientId,
        refresh_token: profile.refreshToken,
        resource: CHATGPT_RESOURCE,
      })
    )
    if (!tokens.access_token || !tokens.expires_in)
      throw new Error("ChatGPT returned an incomplete session.")
    const next = {
      ...profile,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? profile.refreshToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      scopes: tokens.scope?.split(/\s+/) ?? profile.scopes,
    }
    await this.#save(next)
    if (!next.scopes.includes(CHATGPT_PLAN_SCOPE))
      throw new Error(
        "ChatGPT plan usage is no longer enabled. Reconnect your account."
      )
    return next
  }
  async models() {
    const token = await this.accessToken()
    const response = await fetch(`${CHATGPT_RESOURCE}/models`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok)
      throw new Error(
        "ChatGPT models could not be loaded. Reconnect your account or try again."
      )
    return parseChatGPTModels(await response.json())
  }
  login() {
    this.#login ??= this.#authorize().finally(() => {
      this.#login = null
      this.#cancelLogin = null
    })
    return this.#login
  }
  cancelLogin() {
    this.#cancelLogin?.()
  }
  async #authorize(): Promise<{ type: "chatgpt"; connected: true }> {
    const existing = await this.#read()
    const registeredClientId =
      existing?.clientId ?? (await this.#registration())
    const hostId = await this.#hostId()
    const config = await chatGPTDiscovery()
    const state = randomBytes(32).toString("base64url")
    const nonce = randomBytes(32).toString("base64url")
    const verifier = randomBytes(64).toString("base64url")
    let redirectUri = ""
    let consumed = false
    let finished = false
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        server.close()
        server.closeIdleConnections()
        if (error) reject(error)
        else resolve({ type: "chatgpt", connected: true })
      }
      const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1")
        response.setHeader("Cache-Control", "no-store")
        response.setHeader("Content-Type", "text/plain; charset=utf-8")
        response.setHeader("Content-Security-Policy", "default-src 'none'")
        if (request.method !== "GET" || url.pathname !== "/auth/callback") {
          response.writeHead(404).end()
          return
        }
        if (consumed || url.searchParams.get("state") !== state) {
          response.writeHead(400).end("Invalid or expired sign-in attempt.")
          return
        }
        consumed = true
        try {
          const clientId = callbackClientId(
            url.searchParams,
            state,
            registeredClientId
          )
          // Retain the issued registration even if the single-use code expires.
          await this.#write("client-id", clientId)
          const tokens = await exchangeChatGPTToken(
            new URLSearchParams({
              grant_type: "authorization_code",
              client_id: clientId,
              code: url.searchParams.get("code")!,
              code_verifier: verifier,
              redirect_uri: redirectUri,
              resource: CHATGPT_RESOURCE,
            })
          )
          if (!tokens.id_token || !tokens.access_token || !tokens.expires_in)
            throw new Error("ChatGPT returned an incomplete session.")
          const identity = await verifyChatGPTIdentity(
            tokens.id_token,
            clientId,
            nonce
          )
          if (existing && existing.subject !== identity.subject)
            throw new Error(
              "ChatGPT returned a different account. Sign in with the connected account."
            )
          const profile = {
            clientId,
            subject: identity.subject,
            email: identity.email,
            idToken: tokens.id_token,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            scopes: tokens.scope?.split(/\s+/) ?? [],
            expiresAt: Date.now() + tokens.expires_in * 1000,
          }
          if (finished) throw new Error("ChatGPT sign-in expired.")
          await this.#save(profile)
          if (!profile.scopes.includes(CHATGPT_PLAN_SCOPE))
            throw new Error(
              "ChatGPT plan usage was not enabled. Continue with ChatGPT again and allow plan usage."
            )
          response.end(
            "ChatGPT is connected to Forge. You can return to the app."
          )
          finish()
        } catch {
          response
            .writeHead(400)
            .end(
              "ChatGPT could not be connected. Return to Forge and try again."
            )
          finish(
            new Error(
              "ChatGPT sign-in could not be completed. Try again and allow ChatGPT plan usage."
            )
          )
        }
      })
      const timer = setTimeout(
        () => finish(new Error("ChatGPT sign-in timed out. Please try again.")),
        5 * 60_000
      )
      this.#cancelLogin = () =>
        finish(new Error("ChatGPT sign-in was cancelled."))
      server.once("error", () =>
        finish(new Error("The ChatGPT callback could not start."))
      )
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") {
          finish(new Error("The ChatGPT callback could not start."))
          return
        }
        redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
        const url = new URL(config.authorization_endpoint)
        url.search = new URLSearchParams({
          client_id: registeredClientId ?? "dynamic_agent_client",
          ext_agent_host_id: hostId,
          ...(registeredClientId
            ? {
                ...(existing?.idToken
                  ? { id_token_hint: existing.idToken }
                  : {}),
                ...(existing?.email ? { login_hint: existing.email } : {}),
              }
            : { agent_name_hint: "Forge" }),
          response_type: "code",
          redirect_uri: redirectUri,
          scope: CHATGPT_SCOPES,
          resource: CHATGPT_RESOURCE,
          state,
          nonce,
          code_challenge_method: "S256",
          code_challenge: pkceChallenge(verifier),
        }).toString()
        // Authorization URLs may contain an identity hint. Keep them in the main process.
        void shell
          .openExternal(url.href)
          .catch(() =>
            finish(
              new Error("Open the system browser to continue with ChatGPT.")
            )
          )
      })
    })
  }
}
