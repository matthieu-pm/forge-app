import { describe, expect, it } from "vitest"
import { filterSignalInsights, sampleSignalInsights } from "./signals-insights"

const base = {
  status: "inbox" as const,
  statuses: {},
  projectId: "",
  query: "",
  highConfidence: false,
}
describe("Signals insight queue", () => {
  it("starts with all reports awaiting review", () => {
    expect(filterSignalInsights(sampleSignalInsights, base)).toHaveLength(6)
  })
  it("combines product, confidence, and text filters", () => {
    expect(
      filterSignalInsights(sampleSignalInsights, {
        ...base,
        projectId: "acme-product",
        highConfidence: true,
        query: "ARCHIVED",
      }).map((insight) => insight.id)
    ).toEqual(["SIG-107"])
  })
  it("keeps dismissed and reviewed reports out of the inbox and can restore them", () => {
    const statuses = {
      "SIG-108": "reviewed" as const,
      "SIG-107": "dismissed" as const,
    }
    expect(
      filterSignalInsights(sampleSignalInsights, { ...base, statuses })
    ).toHaveLength(4)
    expect(
      filterSignalInsights(sampleSignalInsights, {
        ...base,
        statuses,
        status: "dismissed",
      }).map((insight) => insight.id)
    ).toEqual(["SIG-107"])
    expect(
      filterSignalInsights(sampleSignalInsights, {
        ...base,
        statuses: { ...statuses, "SIG-107": "inbox" },
      })
    ).toHaveLength(5)
  })
  it("returns an empty result for a product without matching findings", () => {
    expect(
      filterSignalInsights(sampleSignalInsights, {
        ...base,
        projectId: "unknown-product",
      })
    ).toEqual([])
  })
})
