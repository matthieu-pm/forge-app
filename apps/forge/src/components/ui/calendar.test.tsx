import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fr } from "react-day-picker/locale"
import { TZDate } from "react-day-picker"
import { Calendar } from "./calendar"
import {
  externalPreferenceEdit,
  renderPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

beforeEach(async () => {
  await setupPreferenceFixture()
})
afterEach(cleanup)

function day(date: Date, locale = "en-US") {
  const button = document.querySelector<HTMLButtonElement>(
    `button[data-day="${date.toLocaleDateString(locale)}"]`
  )
  expect(button).not.toBeNull()
  return button!
}

const boundaries = [
  new Date(2026, 0, 1),
  new Date(2026, 2, 1),
  new Date(2028, 1, 29),
]

describe("FOR-129 AT-01: week presentation and navigation", () => {
  for (const [preference, start, heading] of [
    ["sunday", 0, "Sunday"],
    ["monday", 1, "Monday"],
    ["saturday", 6, "Saturday"],
  ] as const) {
    it.each(boundaries)(`${preference} at %s`, async (selected) => {
      await externalPreferenceEdit("alice", {
        "general.firstDayOfWeek": preference,
      })
      const onSelect = vi.fn()
      renderPreferences(
        <Calendar
          mode="single"
          defaultMonth={selected}
          selected={selected}
          onSelect={onSelect}
        />
      )
      expect(
        screen
          .getAllByRole("columnheader", { hidden: true })[0]
          .getAttribute("aria-label")
      ).toBe(heading)
      expect(
        screen.getAllByRole("columnheader", { hidden: true })
      ).toHaveLength(7)
      const first = document
        .querySelector("td[data-day]")!
        .getAttribute("data-day")!
      expect(new Date(`${first}T12:00:00`).getDay()).toBe(start)
      const startDate = new Date(selected)
      startDate.setDate(
        selected.getDate() - ((selected.getDay() - start + 7) % 7)
      )
      const endDate = new Date(startDate)
      endDate.setDate(startDate.getDate() + 6)
      act(() => day(selected).focus())
      fireEvent.keyDown(document.activeElement!, { key: "Home" })
      await waitFor(() => expect(document.activeElement).toBe(day(startDate)))
      fireEvent.keyDown(document.activeElement!, { key: "End" })
      await waitFor(() => expect(document.activeElement).toBe(day(endDate)))
      const nextWeek = new Date(endDate)
      nextWeek.setDate(endDate.getDate() + 7)
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" })
      await waitFor(() => expect(document.activeElement).toBe(day(nextWeek)))
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" })
      await waitFor(() => expect(document.activeElement).toBe(day(endDate)))
      expect(onSelect).not.toHaveBeenCalled()
    })
  }
})

it("FOR-129 AT-02: a mounted localized zoned calendar refreshes without selecting or remounting", async () => {
  const selected = new TZDate(2026, 0, 1, 10, 30, "Pacific/Auckland")
  const instant = selected.getTime()
  const onSelect = vi.fn()
  renderPreferences(
    <Calendar
      mode="single"
      defaultMonth={selected}
      selected={selected}
      onSelect={onSelect}
      locale={fr}
      timeZone="Pacific/Auckland"
    />
  )
  const root = document.querySelector('[data-slot="calendar"]')
  expect(
    screen
      .getAllByRole("columnheader", { hidden: true })[0]
      .getAttribute("aria-label")
  ).toBe("dimanche")
  for (const [preference, heading] of [
    ["monday", "lundi"],
    ["saturday", "samedi"],
    ["sunday", "dimanche"],
  ]) {
    await act(() =>
      externalPreferenceEdit("alice", { "general.firstDayOfWeek": preference })
    )
    expect(
      screen
        .getAllByRole("columnheader", { hidden: true })[0]
        .getAttribute("aria-label")
    ).toBe(heading)
    expect(document.querySelector('[data-slot="calendar"]')).toBe(root)
    expect(day(selected, "fr").getAttribute("data-selected-single")).toBe(
      "true"
    )
    expect(screen.getByRole("grid").getAttribute("aria-label")).toContain(
      "janvier"
    )
  }
  await act(() =>
    externalPreferenceEdit("bob", { "general.firstDayOfWeek": "saturday" })
  )
  expect(
    screen
      .getAllByRole("columnheader", { hidden: true })[0]
      .getAttribute("aria-label")
  ).toBe("dimanche")
  expect(selected.getTime()).toBe(instant)
  expect(selected.timeZone).toBe("Pacific/Auckland")
  expect(onSelect).not.toHaveBeenCalled()
})
