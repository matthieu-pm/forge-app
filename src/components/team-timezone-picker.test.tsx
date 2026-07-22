import { afterEach, describe, expect, it, vi } from "vitest"

describe("TeamTimezonePicker module", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("does not format the full timezone catalog during page import", async () => {
    vi.resetModules()
    const ActualDateTimeFormat = Intl.DateTimeFormat
    const formatter = vi
      .spyOn(Intl, "DateTimeFormat")
      .mockImplementation(
        (locales, options) => new ActualDateTimeFormat(locales, options)
      )

    await import("@/components/team-timezone-picker")

    expect(formatter).not.toHaveBeenCalled()
  })
})
