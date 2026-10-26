import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { InboxSidebar } from "./inbox-sidebar"
import { scope } from "./inbox-test-fixtures"

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number
      isPrimary = true
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init)
        this.pointerId = init.pointerId ?? 1
      }
    }
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function start() {
  const result = render(
    <InboxSidebar scope={scope} selected={false}>
      Notifications
    </InboxSidebar>
  )
  const handle = screen.getByRole("separator", { name: "Resize inbox sidebar" })
  const sidebar = screen.getByRole("region", { name: "Notifications" })
  vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
    width: 400,
  } as DOMRect)
  Object.assign(handle, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  })
  return { ...result, handle }
}

describe("Inbox sidebar resizing", () => {
  it("follows a drag, clamps both limits, and restores the chosen width", async () => {
    const page = start()
    fireEvent.pointerDown(page.handle, {
      button: 0,
      clientX: 400,
      pointerId: 1,
    })
    fireEvent.pointerMove(page.handle, { clientX: 500, pointerId: 1 })
    expect(page.handle.getAttribute("aria-valuenow")).toBe("125")
    fireEvent.pointerMove(page.handle, { clientX: 0, pointerId: 1 })
    expect(page.handle.getAttribute("aria-valuenow")).toBe("80")
    fireEvent.pointerMove(page.handle, { clientX: 1400, pointerId: 1 })
    expect(page.handle.getAttribute("aria-valuenow")).toBe("200")
    fireEvent.pointerUp(page.handle, { pointerId: 1 })
    expect(document.documentElement.style.cursor).toBe("")
    page.unmount()
    const restored = start()
    await waitFor(() =>
      expect(restored.handle.getAttribute("aria-valuenow")).toBe("200")
    )
    restored.rerender(
      <InboxSidebar
        scope={{ ...scope, userId: "another-user" }}
        selected={false}
      >
        Notifications
      </InboxSidebar>
    )
    await waitFor(() =>
      expect(restored.handle.getAttribute("aria-valuenow")).toBe("100")
    )
  })

  it("resizes by keyboard within the limits and resets on double click", () => {
    const { handle } = start()
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(handle.getAttribute("aria-valuenow")).toBe("105")
    fireEvent.keyDown(handle, { key: "Home" })
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(handle.getAttribute("aria-valuenow")).toBe("80")
    fireEvent.keyDown(handle, { key: "End" })
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(handle.getAttribute("aria-valuenow")).toBe("200")
    fireEvent.doubleClick(handle)
    expect(handle.getAttribute("aria-valuenow")).toBe("100")
  })

  it("cancels a drag without saving it or leaving the resize cursor active", () => {
    const { handle } = start()
    fireEvent.pointerDown(handle, { button: 0, clientX: 400, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 600, pointerId: 1 })
    expect(handle.getAttribute("aria-valuenow")).toBe("150")
    fireEvent.pointerCancel(handle, { pointerId: 1 })
    expect(handle.getAttribute("aria-valuenow")).toBe("100")
    expect(document.documentElement.style.cursor).toBe("")
    expect(localStorage.length).toBe(0)
  })

  it("continues resizing when storing the preference is unavailable", () => {
    const { handle } = start()
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable")
    })
    fireEvent.keyDown(handle, { key: "End" })
    expect(handle.getAttribute("aria-valuenow")).toBe("200")
  })
})
