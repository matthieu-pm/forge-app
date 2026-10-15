// @vitest-environment node
import { createHmac } from "node:crypto"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { getTableColumns } from "drizzle-orm"
import type { Pool } from "@neondatabase/serverless"
import type { auth as appAuth } from "@/lib/auth"
import { sessions, users } from "@/db/auth-schema"

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
const fixtureSecret = "fixture-secret-for-session-query-tests-only"

vi.mock("@/db", async () => {
  const { drizzle } = await import("drizzle-orm/neon-serverless")
  const authSchema = await import("@/db/auth-schema")
  const appSchema = await import("@/db/schema")
  const schema = { ...appSchema, ...authSchema }
  return {
    ...schema,
    schema,
    db: drizzle(
      {
        query: mocks.query,
      } as unknown as Pool,
      { schema }
    ),
  }
})

let auth: typeof appAuth
beforeAll(async () => {
  vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3002")
  vi.stubEnv("BETTER_AUTH_SECRET", fixtureSecret)
  auth = (await import("@/lib/auth")).auth
})
afterAll(() => vi.unstubAllEnvs())
afterEach(() => vi.unstubAllGlobals())

const timestamp = new Date().toISOString()
const session = {
  id: "fixture-session",
  token: "fixture-token",
  userId: "fixture-user",
  activeOrganizationId: "fixture-workspace",
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  createdAt: timestamp,
  updatedAt: timestamp,
  ipAddress: null,
  userAgent: null,
}
const user = {
  id: "fixture-user",
  name: "Fixture",
  email: "fixture@example.test",
  emailVerified: true,
  image: null,
  username: null,
  title: null,
  createdAt: timestamp,
  updatedAt: timestamp,
}

function sessionRows(
  overrides: Partial<typeof session> = {},
  includeUser = true
) {
  const record = { ...session, ...overrides }
  const values: Array<unknown> = Object.keys(getTableColumns(sessions)).map(
    (key) => record[key as keyof typeof session]
  )
  if (includeUser)
    values.push(
      JSON.stringify(
        Object.keys(getTableColumns(users)).map(
          (key) => user[key as keyof typeof user]
        )
      )
    )
  return { rows: [values] }
}

async function sessionRequest(method = "GET") {
  const context = await auth.$context
  const signature = createHmac("sha256", fixtureSecret)
    .update(session.token)
    .digest("base64")
  return auth.handler(
    new Request("http://localhost:3002/api/auth/get-session", {
      method,
      headers: {
        cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
        origin: "http://localhost:3002",
        "Content-Type": "application/json",
      },
    })
  )
}

describe("database-backed session lookup", () => {
  beforeEach(() => {
    mocks.query
      .mockReset()
      .mockImplementation((config: { text: string }) =>
        Promise.resolve(sessionRows({}, !config.text.startsWith("update")))
      )
  })

  it("fetches the session and its user together in one SQL query", async () => {
    const context = await auth.$context
    const result = await context.internalAdapter.findSession("fixture-token")
    expect(result).toMatchObject({
      session: {
        id: "fixture-session",
        activeOrganizationId: "fixture-workspace",
      },
      user: { id: "fixture-user", email: "fixture@example.test" },
    })
    expect(mocks.query).toHaveBeenCalledOnce()
    expect(mocks.query.mock.calls[0][0].text).toContain("left join lateral")
    expect(mocks.query.mock.calls[0][0].text).toContain('from "user"')
  })

  it("returns null immediately when a previously valid session has been revoked", async () => {
    const context = await auth.$context
    expect(
      await context.internalAdapter.findSession("fixture-token")
    ).not.toBeNull()
    mocks.query.mockResolvedValueOnce({ rows: [] })
    expect(
      await context.internalAdapter.findSession("fixture-token")
    ).toBeNull()
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })

  it("validates an aging session without writing its refresh during GET", async () => {
    const response = await sessionRequest()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      session: { id: session.id },
      needsRefresh: true,
    })
    expect(mocks.query).toHaveBeenCalledOnce()
  })

  it("performs the rolling refresh through the client's follow-up POST", async () => {
    const response = await sessionRequest("POST")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ session: { id: session.id } })
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(mocks.query.mock.calls[1][0].text).toMatch(/^update "session"/)
    expect(response.headers.get("set-cookie")).toContain("session_token=")
  })

  it("rejects an expired session without refreshing or deleting it during GET", async () => {
    mocks.query.mockResolvedValue(
      sessionRows({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    )
    const response = await sessionRequest()
    expect(response.status).toBe(200)
    expect(await response.json()).toBeNull()
    expect(mocks.query).toHaveBeenCalledOnce()
  })

  it("sends a valid JSON refresh POST through the real app client", async () => {
    const { authClient } = await import("@/lib/auth-client")
    const requests: Array<Request> = []
    const fetchForAuth = (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const request = new Request(input, init)
      requests.push(request.clone())
      return auth.handler(request)
    }
    const result = await authClient.$fetch("/get-session", {
      baseURL: "http://localhost:3002/api/auth",
      method: "POST",
      customFetchImpl: fetchForAuth,
      headers: {
        origin: "http://localhost:3002",
      },
    })
    expect(result.error).toBeNull()
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe("POST")
    expect(requests[0].headers.get("Content-Type")).toBe("application/json")
    expect(await requests[0].json()).toEqual({})
  })
})
