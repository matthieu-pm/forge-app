// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SignalsSettings } from "./signals-settings"
import {
  defaultSignalPreferences,
  readSignalPreferences,
  signalPreferencesStorageKey,
} from "@/lib/signal-preferences"

afterEach(cleanup)
beforeEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})
const mount = () =>
  render(<SignalsSettings userId="alice" workspaceId="workspace-a" />)
const read = () => readSignalPreferences("alice", "workspace-a")

function addEvent(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add event" }))
  fireEvent.change(screen.getByLabelText("Event name"), {
    target: { value: name },
  })
  fireEvent.change(screen.getByLabelText("Description"), {
    target: { value: "A user completes onboarding." },
  })
  fireEvent.click(screen.getByRole("button", { name: "Add event" }))
}

describe("Signals settings", () => {
  it("saves preferences across remounts and isolates accounts and workspaces", () => {
    const view = mount()
    fireEvent.click(screen.getByRole("switch", { name: "Page views" }))
    fireEvent.change(screen.getByLabelText("What matters to you?"), {
      target: { value: "Focus on onboarding." },
    })
    expect(read().pageViews).toBe(false)
    expect(readSignalPreferences("bob", "workspace-a")).toEqual(
      defaultSignalPreferences
    )
    expect(readSignalPreferences("alice", "workspace-b")).toEqual(
      defaultSignalPreferences
    )
    view.unmount()
    mount()
    expect(
      screen
        .getByRole("switch", { name: "Page views" })
        .getAttribute("aria-checked")
    ).toBe("false")
    expect(
      screen.getByLabelText<HTMLTextAreaElement>("What matters to you?").value
    ).toBe("Focus on onboarding.")
  })

  it("disables capture controls without discarding selected events", () => {
    mount()
    addEvent("onboarding_completed")
    fireEvent.click(screen.getByRole("switch", { name: "Enable capture" }))
    expect(
      screen.getByRole("button", { name: "Add event" }).hasAttribute("disabled")
    ).toBe(true)
    expect(
      screen
        .getByRole("switch", { name: "Page views" })
        .getAttribute("aria-disabled")
    ).toBe("true")
    fireEvent.click(screen.getByRole("switch", { name: "Page views" }))
    expect(read().pageViews).toBe(true)
    expect(
      screen.getByRole("region", { name: "Configuration summary" }).textContent
    ).toContain("Capture is turned off")
    fireEvent.click(screen.getByRole("switch", { name: "Enable capture" }))
    expect(read().events[0].name).toBe("onboarding_completed")
    expect(
      screen
        .getByRole("switch", { name: "Page views" })
        .getAttribute("aria-disabled")
    ).not.toBe("true")
  })

  it("adds, validates, edits, toggles, and removes custom events", () => {
    mount()
    addEvent("onboarding_completed")
    expect(read().events).toHaveLength(1)
    addEvent("onboarding_completed")
    expect(screen.getByRole("alert").textContent).toContain("already exists")
    fireEvent.change(screen.getByLabelText("Event name"), {
      target: { value: "not a valid name" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add event" }))
    expect(screen.getByRole("alert").textContent).toContain(
      "Start with a letter"
    )
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Edit onboarding_completed" })
    )
    fireEvent.change(screen.getByLabelText("Event name"), {
      target: { value: "signup_completed" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    expect(read().events[0].name).toBe("signup_completed")
    fireEvent.click(
      screen.getByRole("switch", { name: "Capture signup_completed" })
    )
    expect(read().events[0].enabled).toBe(false)
    fireEvent.click(
      screen.getByRole("button", { name: "Edit signup_completed" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Remove event" }))
    expect(read().events).toEqual([])
    expect(screen.getByText("No custom events yet")).toBeTruthy()
  })

  it("persists capture scope, sampling, exclusions, and insight choices", () => {
    mount()
    fireEvent.click(screen.getByRole("button", { name: "Environment" }))
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "All environments" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Sample rate" }))
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: "25% of sessions" })
    )
    fireEvent.change(screen.getByLabelText("Excluded pages"), {
      target: { value: "/private/*" },
    })
    fireEvent.change(screen.getByLabelText("Excluded properties"), {
      target: { value: "email\nphone" },
    })
    fireEvent.click(screen.getByRole("switch", { name: "Retention" }))
    expect(read()).toMatchObject({
      environment: "all",
      sampleRate: "25",
      excludedPaths: "/private/*",
      excludedProperties: "email\nphone",
      retention: false,
    })
  })

  it("does not apply an unsaved update when storage fails", () => {
    mount()
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable")
    })
    fireEvent.click(screen.getByRole("switch", { name: "Page views" }))
    expect(screen.getByRole("alert").textContent).toContain("Could not save")
    expect(
      screen
        .getByRole("switch", { name: "Page views" })
        .getAttribute("aria-checked")
    ).toBe("true")
    expect(screen.getByRole("status").textContent).not.toContain("Saved")
  })

  it("retains an event draft after a failed save", () => {
    mount()
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable")
    })
    addEvent("onboarding_completed")
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(screen.getByLabelText<HTMLInputElement>("Event name").value).toBe(
      "onboarding_completed"
    )
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not save this event"
    )
    expect(read().events).toEqual([])
  })

  it("keeps corrupt settings intact and prevents silent overwrites", () => {
    window.localStorage.setItem(
      signalPreferencesStorageKey("alice", "workspace-a"),
      "{invalid"
    )
    mount()
    expect(screen.getByRole("alert").textContent).toContain("Could not load")
    expect(
      screen
        .getByRole("switch", { name: "Enable capture" })
        .getAttribute("aria-disabled")
    ).toBe("true")
    expect(
      window.localStorage.getItem(
        signalPreferencesStorageKey("alice", "workspace-a")
      )
    ).toBe("{invalid")
  })
})
