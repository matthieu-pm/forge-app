import type { OutboxConsumer } from "../../src/application/jobs/outbox-delivery"

/** Local acceptance adapter; never registered in an application worker. */
export function fixtureConsumer(
  origin: string,
  phase?: string
): OutboxConsumer {
  const url = new URL(origin)
  if (url.hostname !== "127.0.0.1" || url.protocol !== "http:")
    throw new Error("Local fixture provider required")
  return {
    id: "fixture-v1",
    providerId: "local_fixture_account",
    topic: "for33.fixture.v1",
    eventVersion: 1,
    startsAt: new Date("2020-01-01"),
    policy: { mode: "provider-idempotent", windowMs: 86400_000 },
    parse(payload) {
      if (
        !payload ||
        typeof payload !== "object" ||
        !("value" in payload) ||
        typeof payload.value !== "number"
      )
        throw new Error("Invalid fixture")
      return { value: payload.value }
    },
    async reconcile(identity) {
      const response = await fetch(
        `${origin}/effects/${identity.idempotencyKey}`,
        { signal: identity.signal }
      )
      if (!response.ok) throw new Error("Fixture unavailable")
      return response.json()
    },
    async deliver(event, identity) {
      if (
        !identity.deadline ||
        Date.now() + 35_000 >= identity.deadline.getTime()
      )
        throw new Error("Fixture deduplication window expired")
      const response = await fetch(
        `${origin}/effects/${identity.idempotencyKey}`,
        {
          method: "POST",
          signal: identity.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event),
        }
      )
      if (!response.ok) throw new Error("PRIVATE-PROVIDER-FAILURE")
      const receipt = await response.json()
      if (phase === "after-acceptance") {
        console.info("accepted")
        await new Promise(() => {})
      }
      return receipt
    },
  }
}
