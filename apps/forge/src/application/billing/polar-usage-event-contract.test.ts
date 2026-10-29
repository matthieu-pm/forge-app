import { describe, expect, it } from "vitest"
import fixture from "./fixtures/polar-sandbox-event-replay.json"
import { singlePolarUsageAcknowledgement } from "./polar-usage-event-contract"

describe("single-event Polar usage acknowledgement", () => {
  it("accepts actual sandbox insertion and unchanged replay", () => {
    expect(singlePolarUsageAcknowledgement(fixture.first.body)).toBe("inserted")
    expect(singlePolarUsageAcknowledgement(fixture.replay.body)).toBe(
      "duplicate"
    )
  })
  it("does not mistake a duplicate reply for provider-side body conflict detection", () => {
    expect(
      singlePolarUsageAcknowledgement(fixture.changedPayloadReplay.body)
    ).toBe("duplicate")
    // The delivery worker must compare the immutable local outbox hash first.
  })
  it("accepts the SDK's optional missing duplicate count only after one insertion", () => {
    expect(singlePolarUsageAcknowledgement({ inserted: 1 })).toBe("inserted")
  })
  it.each([
    { inserted: 0 },
    { inserted: 0, duplicates: 0 },
    { inserted: 1, duplicates: 1 },
    { inserted: 2, duplicates: 0 },
    { inserted: 0, duplicates: 2 },
    { inserted: -1, duplicates: 1 },
    { inserted: 0.5, duplicates: 0.5 },
    { inserted: "1" },
    {},
  ])("refuses malformed or ambiguous acknowledgement %o", (value) => {
    expect(() => singlePolarUsageAcknowledgement(value)).toThrow()
  })
})
