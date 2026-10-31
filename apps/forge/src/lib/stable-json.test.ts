import { expect, it } from "vitest"
import { stableJson } from "./stable-json"

it("preserves a retry identity through schema/key reordering without erasing changed values or array order", () => {
  expect(
    stableJson([
      "team",
      { title: "Draft", assignee: "", document: { content: [], type: "doc" } },
    ])
  ).toBe(
    stableJson([
      "team",
      { document: { type: "doc", content: [] }, assignee: "", title: "Draft" },
    ])
  )
  expect(stableJson({ assignee: "" })).not.toBe(stableJson({}))
  expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]))
})
