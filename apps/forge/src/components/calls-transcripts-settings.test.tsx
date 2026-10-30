// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CallsTranscriptsSettings } from "./calls-transcripts-settings"
import { productStorage } from "@/lib/product-storage"
import {
  failPreferenceSaves,
  readTestPreferences,
  renderPreferences,
  setupPreferenceFixture,
} from "@/test/preference-fixture"
import {
  callPreferencesStorageKey,
  defaultCallPreferences,
  readCallPreferences,
} from "@/lib/call-preferences"

afterEach(cleanup)
beforeEach(async () => {
  await setupPreferenceFixture()
  vi.restoreAllMocks()
  productStorage.clear()
})

describe("Calls and transcripts settings", () => {
  it("persists preferences across remounts without sharing them between users", () => {
    const first = renderPreferences(<CallsTranscriptsSettings userId="alice" />)
    fireEvent.click(screen.getByRole("switch", { name: "Timestamps" }))
    fireEvent.change(screen.getByLabelText("Custom instructions"), {
      target: { value: "Focus on customer feedback." },
    })
    expect(readTestPreferences("alice").calls.timestamps).toBe(false)
    expect(readTestPreferences("bob").calls).toEqual(defaultCallPreferences)
    first.unmount()
    renderPreferences(<CallsTranscriptsSettings userId="alice" />)
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
    renderPreferences(<CallsTranscriptsSettings userId="alice" />)
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }))
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "Ask me each time" })
    )
    expect(readTestPreferences("alice").calls.recordingMode).toBe("ask")
    fireEvent.click(screen.getByRole("button", { name: "Spoken language" }))
    fireEvent.click(screen.getByRole("menuitemradio", { name: "French" }))
    expect(readTestPreferences("alice").calls.language).toBe("fr")
  })

  it("updates the sample transcript and summary from formatting choices", () => {
    renderPreferences(<CallsTranscriptsSettings userId="alice" />)
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
    renderPreferences(<CallsTranscriptsSettings userId="alice" />)
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
    expect(readTestPreferences("alice").calls.actionItems).toBe(true)
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

  it("shows unsaved state and retries an offline account save", async () => {
    renderPreferences(<CallsTranscriptsSettings userId="alice" />)
    failPreferenceSaves("alice")
    fireEvent.click(screen.getByRole("switch", { name: "Speaker labels" }))
    await screen.findByRole("alert")
    expect(screen.getByRole("alert").textContent).toContain("not saved")
    expect(
      screen
        .getByRole("switch", { name: "Speaker labels" })
        .getAttribute("aria-checked")
    ).toBe("false")
    failPreferenceSaves("alice", false)
    fireEvent.click(screen.getByRole("button", { name: "Retry preferences" }))
    await screen.findByText("Preferences saved to your account")
  })

  it("recovers from malformed data and merges partial stored preferences", () => {
    productStorage.setItem(callPreferencesStorageKey("alice"), "{bad json")
    expect(readCallPreferences("alice")).toEqual(defaultCallPreferences)
    productStorage.setItem(
      callPreferencesStorageKey("alice"),
      JSON.stringify({ language: "fr" })
    )
    expect(readCallPreferences("alice")).toEqual({
      ...defaultCallPreferences,
      language: "fr",
    })
    productStorage.setItem(
      callPreferencesStorageKey("alice"),
      JSON.stringify({ recordingMode: "invalid" })
    )
    expect(readCallPreferences("alice")).toEqual(defaultCallPreferences)
  })
})
