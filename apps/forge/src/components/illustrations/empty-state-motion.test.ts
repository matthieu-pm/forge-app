import { createElement } from "react"
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { EmptyStateArt } from "./empty-state-art"
import { issuePagePhase, mountEmptyStateMotion } from "./empty-state-motion"

afterEach(() => {
  cleanup()
  document.body.innerHTML = ""
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup(reduced = false) {
  const poses = ["right", "turning", "left"].map(
    (side) => `<path data-side="${side}"/>`
  )
  document.body.innerHTML = `<div class="empty-state-content"><svg><g
    data-motion="issue-page" data-page-frames='${JSON.stringify(poses)}'>${poses[0]}</g></svg><button>Inside</button></div><button>Outside</button>`
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

it("turns automatically from right to left, pauses, then returns", () => {
  const rig = setup()
  rig.advance(30)
  expect(rig.page.querySelector("path")?.getAttribute("data-side")).toBe(
    "right"
  )
  rig.advance(60)
  expect(rig.page.querySelector("path")?.getAttribute("data-side")).toBe(
    "turning"
  )
  rig.advance(90)
  expect(rig.svg.style.getPropertyValue("--art-phase")).toBe("1.00000")
  expect(rig.page.querySelector("path")?.getAttribute("data-side")).toBe("left")
  rig.advance(30)
  expect(rig.svg.style.getPropertyValue("--art-phase")).toBe("1.00000")
  rig.advance(150)
  expect(rig.page.querySelector("path")?.getAttribute("data-side")).toBe(
    "right"
  )
  rig.dispose?.()
})

it("starts the turn early on keyboard focus", () => {
  const rig = setup()
  rig.focus()
  rig.advance(30)
  expect(Number(rig.svg.style.getPropertyValue("--art-phase"))).toBeGreaterThan(
    0.1
  )
  rig.dispose?.()
})

it("has continuous eased turns and readable rests at both ends", () => {
  expect(issuePagePhase(0)).toBe(0)
  expect(issuePagePhase(600)).toBe(0)
  expect(issuePagePhase(1500)).toBeCloseTo(0.5)
  expect(issuePagePhase(2400)).toBe(1)
  expect(issuePagePhase(3999)).toBe(1)
  expect(issuePagePhase(4900)).toBeCloseTo(0.5)
  expect(issuePagePhase(5800)).toBe(0)
  expect(issuePagePhase(7200)).toBe(0)
})

it("does not animate the issue page under reduced motion", () => {
  const rig = setup(true)
  rig.focus()
  rig.advance()
  expect(rig.page.getAttribute("transform")).toBeNull()
  expect(rig.frames.size).toBe(0)
  rig.dispose?.()
})

it("pauses the page turn offscreen and cancels its frame when disposed", () => {
  const rig = setup()
  rig.focus()
  rig.advance(60)
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

it("keeps turning the visible paper after its React parent rerenders", () => {
  const rig = setup()
  rig.dispose?.()
  document.body.innerHTML = ""
  vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 10, 196, 157)
  )
  const view = render(createElement(EmptyStateArt, { kind: "issues" }))
  rig.advance(90)
  const paper = () =>
    view.container.querySelector(".issue-sheet path")?.getAttribute("d")
  const turning = paper()
  const layer = view.container.querySelector('[data-motion="issue-page"]')!
  view.rerender(createElement(EmptyStateArt, { kind: "issues" }))
  expect(layer.isConnected).toBe(true)
  rig.advance(90)
  const left = paper()
  rig.advance(180)
  const right = paper()
  expect(left).not.toBe(turning)
  expect(left).not.toBe(right)
})
