// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CallsTranscriptsSettings } from "./calls-transcripts-settings"
import {
  callPreferencesStorageKey,
  defaultCallPreferences,
  readCallPreferences,
} from "@/lib/call-preferences"

afterEach(cleanup)
beforeEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe("Calls and transcripts settings", () => {
  it("persists preferences across remounts without sharing them between users", () => {
    const first = render(<CallsTranscriptsSettings userId="alice" />)
    fireEvent.click(screen.getByRole("switch", { name: "Timestamps" }))
    fireEvent.change(screen.getByLabelText("Custom instructions"), {
      target: { value: "Focus on customer feedback." },
    })
    expect(readCallPreferences("alice").timestamps).toBe(false)
    expect(readCallPreferences("bob")).toEqual(defaultCallPreferences)
    first.unmount()
    render(<CallsTranscriptsSettings userId="alice" />)
    expect(
      screen
        .getByRole("switch", { name: "Timestamps" })
        .getAttribute("aria-checked")
    ).toBe("false")
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Custom instructions").value
    ).toBe("Focus on customer feedback.")
  })

  it("saves recording and language selections", () => {
    render(<CallsTranscriptsSettings userId="alice" />)
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }))
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Ask me each time" })
    )
    expect(readCallPreferences("alice").recordingMode).toBe("ask")
    fireEvent.click(screen.getByRole("button", { name: "Spoken language" }))
    fireEvent.click(screen.getByRole("menuitemradio", { name: "French" }))
    expect(readCallPreferences("alice").language).toBe("fr")
  })

  it("updates the sample transcript and summary from formatting choices", () => {
    render(<CallsTranscriptsSettings userId="alice" />)
    const preview = screen.getByRole("region", { name: "Output preview" })
    fireEvent.click(screen.getByRole("switch", { name: "Speaker labels" }))
    fireEvent.click(screen.getByRole("switch", { name: "Timestamps" }))
    fireEvent.click(screen.getByRole("switch", { name: "Remove filler words" }))
    expect(preview.textContent).not.toContain("00:12")
    expect(preview.textContent).not.toContain("Alex:")
    expect(preview.textContent).toContain("Um, I’ll, you know")
    fireEvent.click(screen.getByRole("button", { name: "Summary format" }))
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Paragraphs" }))
    expect(within(preview).queryByRole("list")).toBeNull()
    fireEvent.click(screen.getByRole("switch", { name: "Action items" }))
    expect(
      within(preview).queryByRole("heading", { name: "Action items" })
    ).toBeNull()
  })

  it("disables summary customization and preserves choices when summaries are off", () => {
    render(<CallsTranscriptsSettings userId="alice" />)
    fireEvent.change(screen.getByLabelText("Custom instructions"), {
      target: { value: "Keep it short." },
    })
    fireEvent.click(screen.getByRole("switch", { name: "Generate a summary" }))
    expect(
      screen
        .getByRole("group", { name: "Summary preferences" })
        .hasAttribute("disabled")
    ).toBe(true)
    expect(
      screen
        .getByRole("switch", { name: "Action items" })
        .getAttribute("aria-disabled")
    ).toBe("true")
    fireEvent.click(screen.getByRole("switch", { name: "Action items" }))
    expect(readCallPreferences("alice").actionItems).toBe(true)
    expect(
      within(
        screen.getByRole("region", { name: "Output preview" })
      ).queryByRole("heading", { name: "Summary" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("switch", { name: "Generate a summary" }))
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("Custom instructions").value
    ).toBe("Keep it short.")
  })

  it("shows a save error without applying an unsaved setting", () => {
    render(<CallsTranscriptsSettings userId="alice" />)
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable")
    })
    fireEvent.click(screen.getByRole("switch", { name: "Speaker labels" }))
    expect(screen.getByRole("alert").textContent).toContain("Could not save")
    expect(
      screen
        .getByRole("switch", { name: "Speaker labels" })
        .getAttribute("aria-checked")
    ).toBe("true")
    expect(screen.getByRole("status").textContent).not.toContain("Saved")
  })

  it("recovers from malformed data and merges partial stored preferences", () => {
    window.localStorage.setItem(callPreferencesStorageKey("alice"), "{bad json")
    expect(readCallPreferences("alice")).toEqual(defaultCallPreferences)
    window.localStorage.setItem(
      callPreferencesStorageKey("alice"),
      JSON.stringify({ language: "fr" })
    )
    expect(readCallPreferences("alice")).toEqual({
      ...defaultCallPreferences,
      language: "fr",
    })
    window.localStorage.setItem(
      callPreferencesStorageKey("alice"),
      JSON.stringify({ recordingMode: "invalid" })
    )
    expect(readCallPreferences("alice")).toEqual(defaultCallPreferences)
  })
})
