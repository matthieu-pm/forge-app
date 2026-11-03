import * as React from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { fr } from "react-day-picker/locale"
import { DateInput } from "./date-input"
import {
  externalPreferenceEdit,
  renderPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"

beforeEach(async () => {
  await setupPreferenceFixture()
})
afterEach(cleanup)

function choose(date: string) {
  fireEvent.click(
    document.querySelector<HTMLButtonElement>(`button[data-day="${date}"]`)!
  )
}

it("preserves a datetime's time and civil date through preference changes, then changes only the chosen day", async () => {
  const changed = vi.fn()
  function Field() {
    const [value, setValue] = React.useState("2026-03-08T01:30:45")
    return (
      <DateInput
        type="datetime-local"
        value={value}
        aria-label="First scheduled run"
        step="1"
        onValueChange={(next) => {
          changed(next)
          setValue(next)
        }}
        locale={fr}
      />
    )
  }
  renderPreferences(<Field />)
  const date = screen.getByRole<HTMLInputElement>("textbox", {
    name: "First scheduled run",
  })
  const time = screen.getByLabelText<HTMLInputElement>(
    "First scheduled run time"
  )
  fireEvent.click(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Open calendar for First scheduled run",
    })
  )
  const root = document.querySelector('[data-slot="calendar"]')
  await act(() =>
    externalPreferenceEdit("alice", { "general.firstDayOfWeek": "saturday" })
  )
  expect(document.querySelector('[data-slot="calendar"]')).toBe(root)
  expect(
    screen
      .getAllByRole("columnheader", { hidden: true })[0]
      .getAttribute("aria-label")
  ).toBe("samedi")
  expect(date.value).toBe("2026-03-08")
  expect(time.value).toBe("01:30:45")
  expect(changed).not.toHaveBeenCalled()
  choose("09/03/2026")
  expect(changed).toHaveBeenLastCalledWith("2026-03-09T01:30:45")
  expect(time.value).toBe("01:30:45")
  fireEvent.change(time, { target: { value: "14:15:30" } })
  expect(changed).toHaveBeenLastCalledWith("2026-03-09T14:15:30")
  fireEvent.change(date, { target: { value: "" } })
  expect(changed).toHaveBeenLastCalledWith("")
})

it("allows typing, clearing, and external value updates without accepting incomplete, impossible or out-of-range dates", () => {
  const changed = vi.fn()
  const { rerender } = render(
    <DateInput
      aria-label="Due"
      value="2026-02-01"
      min="2026-02-01"
      max="2026-03-01"
      onValueChange={changed}
    />
  )
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: "Due" })
  for (const invalid of ["2026-0", "2026-02-31", "2026-01-31", "2026-03-02"]) {
    fireEvent.change(field, { target: { value: invalid } })
    expect(field.value).toBe(invalid)
    expect(field.checkValidity()).toBe(false)
  }
  expect(changed).not.toHaveBeenCalled()
  fireEvent.change(field, { target: { value: "2026-02-28" } })
  expect(field.checkValidity()).toBe(true)
  expect(changed).toHaveBeenLastCalledWith("2026-02-28")
  rerender(
    <DateInput aria-label="Due" value="2027-01-01" onValueChange={changed} />
  )
  expect(field.value).toBe("2027-01-01")
  fireEvent.change(field, { target: { value: "" } })
  expect(changed).toHaveBeenLastCalledWith("")
})

it("keeps required, disabled and read-only behavior", () => {
  const changed = vi.fn()
  const { rerender } = render(
    <DateInput
      value=""
      onValueChange={changed}
      required
      aria-label="Due"
      disabled
    />
  )
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Due" }).disabled
  ).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>("button").disabled).toBe(true)
  rerender(
    <DateInput value="" onValueChange={changed} required aria-label="Due" />
  )
  expect(
    screen
      .getByRole<HTMLInputElement>("textbox", { name: "Due" })
      .checkValidity()
  ).toBe(false)
  rerender(
    <DateInput
      value="2026-01-01"
      onValueChange={changed}
      readOnly
      aria-label="Due"
    />
  )
  expect(
    screen.getByRole<HTMLInputElement>("textbox", { name: "Due" }).readOnly
  ).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>("button").disabled).toBe(true)
  expect(changed).not.toHaveBeenCalled()
})

it("initializes a new datetime only on explicit selection and preserves time-only drafts", () => {
  const changed = vi.fn()
  function Field() {
    const [value, setValue] = React.useState("")
    return (
      <DateInput
        type="datetime-local"
        aria-label="Call date"
        value={value}
        inlineCalendar
        onValueChange={(next) => {
          changed(next)
          setValue(next)
        }}
      />
    )
  }
  renderPreferences(<Field />)
  const time = screen.getByLabelText<HTMLInputElement>("Call date time")
  fireEvent.change(time, { target: { value: "16:45" } })
  expect(changed).toHaveBeenLastCalledWith("")
  const button = document.querySelector<HTMLButtonElement>(
    "button[data-day]:not([disabled])"
  )!
  fireEvent.click(button)
  expect(changed.mock.lastCall![0]).toMatch(/T16:45$/)
  expect(time.value).toBe("16:45")
})

it("clears manual validation errors after choosing a valid calendar day", () => {
  function Field() {
    const [value, setValue] = React.useState("2026-02-01")
    return (
      <DateInput
        aria-label="Due"
        value={value}
        onValueChange={setValue}
        inlineCalendar
        min="2026-02-01"
        max="2026-03-01"
      />
    )
  }
  renderPreferences(<Field />)
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: "Due" })
  fireEvent.change(input, { target: { value: "2026-02-31" } })
  expect(input.checkValidity()).toBe(false)
  choose("2/28/2026")
  expect(input.value).toBe("2026-02-28")
  expect(input.checkValidity()).toBe(true)
})
