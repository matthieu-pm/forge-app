/** Visible-only, reduced-motion-aware animation shared by React and the QA gallery. */
export function mountEmptyStateMotion(svg: SVGSVGElement, kind: string) {
  if (
    !["inbox", "reviews", "signals", "milestones", "calls", "issues"].includes(
      kind
    ) ||
    typeof matchMedia !== "function" ||
    typeof requestAnimationFrame !== "function" ||
    typeof IntersectionObserver !== "function"
  )
    return
  const still = matchMedia("(prefers-reduced-motion: reduce)")
  const content = svg.closest(".empty-state-content") ?? svg
  let frame = 0
  let visible = false
  let hovered = false
  let focused = false
  let phase = 0
  let last = 0
  let started = 0
  const period = kind === "reviews" ? 6200 : kind === "signals" ? 8400 : 7600
  const page = svg.querySelector<SVGGElement>('[data-motion="issue-page"]')
  const pageFrames: Array<string> = JSON.parse(
    page?.getAttribute("data-page-frames") ?? "[]"
  )
  let pageFrame = -1
  let pageTime = 0

  function paint() {
    svg.style.setProperty("--art-phase", phase.toFixed(5))
    if (!page || !pageFrames.length) return
    const index = Math.round(phase * (pageFrames.length - 1))
    if (index === pageFrame) return
    pageFrame = index
    // Trusted, build-generated SVG. Only the turning paper and the ring arcs
    // change: their physical depth order is solved ahead of time for each pose.
    page.innerHTML = pageFrames[index]
  }

  function draw(now: number) {
    frame = 0
    if (!visible || still.matches) return
    if (!started) started = now
    const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60
    last = now
    const elapsed = Math.max(0, now - started - 900)
    if (kind === "issues") {
      pageTime += dt * 1000
      phase = issuePagePhase(pageTime)
    } else {
      const idle = (1 - Math.cos((elapsed / period) * Math.PI * 2)) / 2
      const target = hovered || focused ? 1 : idle
      phase += (target - phase) * (1 - Math.exp(-dt / 0.18))
    }
    paint()
    frame = requestAnimationFrame(draw)
  }
  function start() {
    if (!frame && visible && !still.matches) {
      last = 0
      frame = requestAnimationFrame(draw)
    }
  }
  function stop() {
    cancelAnimationFrame(frame)
    frame = 0
    last = 0
  }
  function enter() {
    hovered = true
    if (kind === "issues" && phase === 0) pageTime = 600
    start()
  }
  function leave() {
    hovered = false
    start()
  }
  function focus() {
    focused = true
    if (kind === "issues" && phase === 0) pageTime = 600
    start()
  }
  function blur(event: Event) {
    focused = content.contains(
      (event as FocusEvent).relatedTarget as Node | null
    )
    start()
  }
  function preference() {
    stop()
    if (still.matches) {
      phase = 0
      pageTime = 0
      paint()
    } else start()
  }
  function visibility() {
    const box = svg.getBoundingClientRect()
    visible =
      document.visibilityState !== "hidden" &&
      box.bottom > 0 &&
      box.right > 0 &&
      box.top < innerHeight &&
      box.left < innerWidth
    if (visible) start()
    else stop()
  }
  // Scroll events also cover SVG overflow bounds and nested app scroll panes.
  const observer = new IntersectionObserver(visibility)
  observer.observe(content)
  document.addEventListener("scroll", visibility, {
    capture: true,
    passive: true,
  })
  document.addEventListener("visibilitychange", visibility)
  window.addEventListener("resize", visibility, { passive: true })
  visibility()
  svg.addEventListener("pointerenter", enter)
  svg.addEventListener("pointerleave", leave)
  content.addEventListener("focusin", focus)
  content.addEventListener("focusout", blur)
  still.addEventListener("change", preference)
  return () => {
    stop()
    observer.disconnect()
    document.removeEventListener("scroll", visibility, true)
    document.removeEventListener("visibilitychange", visibility)
    window.removeEventListener("resize", visibility)
    svg.removeEventListener("pointerenter", enter)
    svg.removeEventListener("pointerleave", leave)
    content.removeEventListener("focusin", focus)
    content.removeEventListener("focusout", blur)
    still.removeEventListener("change", preference)
  }
}

/** A full right-to-left turn, a readable rest on each side, then a return. */
export function issuePagePhase(time: number) {
  const t = time % 7200
  const ease = (value: number) => (1 - Math.cos(Math.PI * value)) / 2
  if (t < 600) return 0
  if (t < 2400) return ease((t - 600) / 1800)
  if (t < 4000) return 1
  if (t < 5800) return 1 - ease((t - 4000) / 1800)
  return 0
}
