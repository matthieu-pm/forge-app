// @vitest-environment node
import { expect, it, vi } from "vitest"
import { handleInboxWorker } from "./inbox-worker-handler"

const secret = "x".repeat(40)
const env = {
  FORGE_INBOX_DELIVERY_ENABLED: "true",
  FORGE_INBOX_DELIVERY_SECRET: secret,
}
const request = (token = secret, method = "POST") =>
  new Request("https://fixture.test/api/internal/inbox-delivery", {
    method,
    headers: { authorization: `Bearer ${token}` },
  })
it("rejects disabled, unauthenticated and wrong-method requests without touching jobs", async () => {
  const run = vi.fn()
  for (const [req, config] of [
    [request("bad"), env],
    [request(secret, "GET"), env],
    [request(), { ...env, FORGE_INBOX_DELIVERY_ENABLED: "false" }],
  ] as const) {
    expect((await handleInboxWorker(req, config, run)).status).toBe(404)
  }
  expect(run).not.toHaveBeenCalled()
})
it("reports aggregate outcomes and returns failure for inactive or failed deliveries", async () => {
  for (const result of [
    { scheduled: 2, outcomes: [{ state: "completed" }, { state: "dead" }] },
    { scheduled: 0, outcomes: [], inactive: true },
  ])
    expect(
      (await handleInboxWorker(request(), env, () => Promise.resolve(result)))
        .status
    ).toBe(503)
  const response = await handleInboxWorker(request(), env, () =>
    Promise.resolve({
      scheduled: 1,
      outcomes: [{ state: "completed" }],
    })
  )
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual({
    scheduled: 1,
    completed: 1,
    deferred: 0,
    failed: 0,
    inactive: false,
  })
})

it("reports a resumable batch as progress instead of a failed delivery", async () => {
  const response = await handleInboxWorker(request(), env, () =>
    Promise.resolve({ scheduled: 1, outcomes: [{ state: "deferred" }] })
  )
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    completed: 0,
    deferred: 1,
    failed: 0,
  })
})
