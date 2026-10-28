// @vitest-environment node
import { describe, expect, it, vi } from "vitest"
import { fetchEcbReferenceRate } from "./ecb-reference-rate.server"
import { ECB_REFERENCE_URL } from "./workspace-overage-money"

const xml = `<gesmes:Envelope xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube><Cube time='2026-10-28'><Cube currency='USD' rate='1.1133'/></Cube></Cube></gesmes:Envelope>`
const now = new Date("2026-10-29T00:00:00Z")
describe("ECB reference-rate boundary", () => {
  it("reads the fixed official feed without credentials and records source/rate/availability", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(xml))
    expect(await fetchEcbReferenceRate(fetcher, () => now)).toMatchObject({
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      source: "ecb-daily-reference",
      sourceUrl: ECB_REFERENCE_URL,
      referenceDate: "2026-10-28",
      usdPerEur: "1.1133",
      observedAt: now.toISOString(),
    })
    expect(fetcher).toHaveBeenCalledWith(
      ECB_REFERENCE_URL,
      expect.objectContaining({ redirect: "error", cache: "no-store" })
    )
  })
  it.each([
    "<!DOCTYPE unsafe>" + xml,
    xml.slice(0, -20),
    xml.replace("1.1133", "0"),
    xml.replace("USD", "GBP"),
    xml.replace("2026-10-28", "2026-10-30"),
    xml.replace("2026-10-28", "2026-10-01"),
    xml.replace(
      "<Cube currency='USD'",
      "<Cube currency='USD' rate='2'/><Cube currency='USD'"
    ),
    "x".repeat(65537),
  ])("rejects unsupported, stale or unbounded feed input", async (body) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body))
    await expect(fetchEcbReferenceRate(fetcher, () => now)).rejects.toThrow()
  })
  it("does not infer a rate from an upstream outage", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("unavailable", { status: 503 }))
    await expect(fetchEcbReferenceRate(fetcher, () => now)).rejects.toThrow(
      "SOURCE_UNAVAILABLE"
    )
  })
})
