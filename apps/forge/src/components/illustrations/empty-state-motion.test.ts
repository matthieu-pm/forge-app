import { afterEach, expect, it, vi } from "vitest"
import { mountEmptyStateMotion } from "./empty-state-motion"

afterEach(() => {
  document.body.innerHTML = ""
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup(reduced = false) {
  document.body.innerHTML = `<div class="empty-state-content"><svg><g
    data-motion="issue-page" data-page-angle="0.0872664626" data-page-hinge="100 80"
    data-page-x="0.7 0.4" data-page-z="0 -0.7"
    data-page-inverse="0.7 1.2"></g></svg><button>Inside</button></div><button>Outside</button>`
  const svg = document.querySelector("svg")!
  const page = document.querySelector("g")!
  const content = document.querySelector(".empty-state-content")!
  const box = vi
    .spyOn(svg, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(10, 10, 196, 157))
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  vi.stubGlobal("matchMedia", () => ({
    matches: reduced,
    addEventListener() {},
    removeEventListener() {},
  }))
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    }
  )
  let now = 1000
  let id = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback)
    return id
  })
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key))
  function advance(count = 150) {
    for (let i = 0; i < count; i++) {
      now += 1000 / 60
      const callbacks = [...frames.values()]
      frames.clear()
      callbacks.forEach((callback) => callback(now))
    }
  }
  const dispose = mountEmptyStateMotion(svg, "issues")
  const focus = () =>
    content.dispatchEvent(new FocusEvent("focusin", { bubbles: true }))
  const blur = () =>
    content.dispatchEvent(
      new FocusEvent("focusout", {
        bubbles: true,
        relatedTarget: document.body.lastElementChild,
      })
    )
  return { svg, page, box, frames, advance, focus, blur, dispose }
}

it("rests quietly, lifts from the bound edge on focus, and settles when focus leaves", () => {
  const rig = setup()
  rig.advance()
  expect(rig.svg.style.getPropertyValue("--art-phase")).toBe("0.00000")
  expect(rig.frames.size).toBe(0)
  rig.focus()
  rig.advance()
  expect(rig.svg.style.getPropertyValue("--art-phase")).toBe("1.00000")
  const [a, b, c, d, e, f] = rig.page
    .getAttribute("transform")!
    .slice(7, -1)
    .split(" ")
    .map(Number)
  expect([a, b, c, d]).not.toEqual([1, 0, 0, 1])
  expect(a * 100 + c * 80 + e).toBeCloseTo(100, 3)
  expect(b * 100 + d * 80 + f).toBeCloseTo(80, 3)
  expect(rig.frames.size).toBe(0)
  rig.blur()
  rig.advance()
  expect(rig.svg.style.getPropertyValue("--art-phase")).toBe("0.00000")
  expect(rig.frames.size).toBe(0)
  rig.dispose?.()
})

it("does not animate the issue page under reduced motion", () => {
  const rig = setup(true)
  rig.focus()
  rig.advance()
  expect(rig.page.getAttribute("transform")).toBeNull()
  expect(rig.frames.size).toBe(0)
  rig.dispose?.()
})

it("pauses the page lift offscreen and cancels its frame when disposed", () => {
  const rig = setup()
  rig.focus()
  rig.advance(6)
  const phase = rig.svg.style.getPropertyValue("--art-phase")
  expect(Number(phase)).toBeGreaterThan(0)
  rig.box.mockReturnValue(new DOMRect(10, -1000, 196, 157))
  document.dispatchEvent(new Event("scroll"))
  rig.advance()
  expect(rig.svg.style.getPropertyValue("--art-phase")).toBe(phase)
  expect(rig.frames.size).toBe(0)
  rig.box.mockReturnValue(new DOMRect(10, 10, 196, 157))
  document.dispatchEvent(new Event("scroll"))
  expect(rig.frames.size).toBe(1)
  rig.dispose?.()
  expect(rig.frames.size).toBe(0)
})
