// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  codeReviewStorageKey,
  defaultCodeReviewPreferences,
  readCodeReviewPreferences,
  writeCodeReviewPreferences,
} from "./code-review-preferences"
import { productStorage } from "@/lib/product-storage"

beforeEach(() => {
  productStorage.clear()
  vi.restoreAllMocks()
})
describe("code review preferences", () => {
  it("isolates preferences between signed-in users and fills older records", () => {
    productStorage.setItem(
      codeReviewStorageKey("alice"),
      JSON.stringify({ attachmentFormat: "number" })
    )
    expect(readCodeReviewPreferences("alice")).toEqual({
      ...defaultCodeReviewPreferences,
      attachmentFormat: "number",
    })
    expect(readCodeReviewPreferences("bob")).toEqual(
      defaultCodeReviewPreferences
    )
  })
  it("recovers from corrupt or invalid stored preferences", () => {
    for (const stored of [
      "not JSON",
      '{"startOnBranchCopy":"false"}',
      '{"codingTools":["unknown"]}',
    ]) {
      productStorage.setItem(codeReviewStorageKey("alice"), stored)
      expect(readCodeReviewPreferences("alice")).toEqual(
        defaultCodeReviewPreferences
      )
    }
  })
  it("round-trips changes and reports unavailable storage", () => {
    const preferences = {
      ...defaultCodeReviewPreferences,
      startOnToolOpen: false,
    }
    writeCodeReviewPreferences("alice", preferences)
    expect(readCodeReviewPreferences("alice")).toEqual(preferences)
    vi.spyOn(productStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage full")
    })
    expect(() => writeCodeReviewPreferences("alice", preferences)).toThrow(
      "Storage full"
    )
  })
})
