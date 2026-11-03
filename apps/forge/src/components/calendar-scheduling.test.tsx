import { act, cleanup, fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { LoopTriggerEditor } from "./loop-configuration"
import type { LoopTrigger } from "@/lib/loop-contract"
import {
  externalPreferenceEdit,
  renderPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

beforeEach(async () => {
  await setupPreferenceFixture()
})
afterEach(cleanup)

it("reorders schedule weekdays without changing ISO weekday values or the stored schedule", async () => {
  const schedule: LoopTrigger = {
    kind: "schedule",
    unit: "weeks",
    interval: 1,
    timeZone: "Pacific/Auckland",
    startAt: "2026-01-01T10:30:00.000Z",
    weekdays: [1, 7],
  }
  const onChange = vi.fn()
  renderPreferences(
    <LoopTriggerEditor value={schedule} onChange={onChange} timeZone="UTC" />
  )
  for (const [preference, order] of [
    ["saturday", ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"]],
    ["monday", ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]],
    ["sunday", ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]],
  ] as const) {
    await act(() =>
      externalPreferenceEdit("alice", { "general.firstDayOfWeek": preference })
    )
    expect(
      screen
        .getAllByRole("checkbox")
        .map((e) => e.parentElement!.textContent.trim())
    ).toEqual(order)
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Sun" }).checked
    ).toBe(true)
    expect(
      screen.getByRole<HTMLInputElement>("checkbox", { name: "Mon" }).checked
    ).toBe(true)
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "First scheduled run",
      }).value
    ).toBe("2026-01-01")
    expect(
      screen.getByLabelText<HTMLInputElement>("First scheduled run time").value
    ).toBe("23:30")
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: "Schedule timezone",
      }).value
    ).toBe("Pacific/Auckland")
  }
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(
    screen.getByRole<HTMLInputElement>("checkbox", { name: "Sat" })
  )
  expect(onChange).toHaveBeenLastCalledWith({
    ...schedule,
    weekdays: [1, 7, 6],
  })
})
