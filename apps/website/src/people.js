import { gsap } from "gsap"

// Surface samples are lit in 3D, then resolved through a depth buffer into text cells.
// No photographs, textures, models, or video are fetched by this scene.
const glyphs = " .,:;itfx%$#@"
const samples = []
for (let i = 0; i < 720; i++) {
  const y = 1 - (i / 719) * 2
  const r = Math.sqrt(1 - y * y)
  const a = i * 2.3999632297
  samples.push([Math.cos(a) * r, y, Math.sin(a) * r])
}
const add = (a, b) => a.map((v, i) => v + b[i])
const limbEnd = (start, length, swing) =>
  add(start, [0, -length * Math.cos(swing), length * Math.sin(swing)])

function skeleton(phase) {
  const swing = Math.sin(phase) * 0.43
  const lift = Math.cos(phase * 2) * 0.025
  const hip = [0, 1.85 + lift, 0]
  const shoulder = [0, 2.84 + lift, 0]
  const parts = []
  const ellipsoid = (center, radius, style = 0) =>
    parts.push({ center, radius, style })
  const bone = (a, b, radius, depth = radius, style = 0) => {
    const d = b.map((v, i) => v - a[i])
    const length = Math.hypot(...d)
    parts.push({
      center: a.map((v, i) => (v + b[i]) / 2),
      radius: [radius, length * 0.57, depth],
      angle: Math.atan2(d[2], -d[1]),
      style,
    })
  }
  ellipsoid(add(hip, [0, 0.15, 0]), [0.34, 0.28, 0.21], 1)
  ellipsoid(add(hip, [0, 0.62, 0]), [0.39, 0.59, 0.235], 1)
  ellipsoid(add(shoulder, [0, -0.02, 0]), [0.46, 0.2, 0.235], 1)
  ellipsoid(add(shoulder, [0, 0.25, 0]), [0.13, 0.22, 0.13])
  ellipsoid(add(shoulder, [0, 0.58, 0.018]), [0.235, 0.315, 0.245])
  // A small nose helps the shaded profile read as a human face.
  ellipsoid(add(shoulder, [0, 0.59, 0.25]), [0.065, 0.09, 0.075])
  for (const side of [-1, 1]) {
    const legAngle = side * swing
    const top = add(hip, [side * 0.19, -0.04, 0])
    const knee = limbEnd(top, 0.89, legAngle)
    const bend = Math.max(0, -side * Math.sin(phase)) * 0.5
    const ankle = limbEnd(knee, 0.82, legAngle - bend)
    bone(top, knee, 0.18, 0.18, 2)
    bone(knee, ankle, 0.12, 0.13, 2)
    ellipsoid(add(ankle, [0, -0.04, 0.11]), [0.125, 0.105, 0.25], 2)
    const armTop = add(shoulder, [side * 0.45, -0.04, 0])
    const elbow = limbEnd(armTop, 0.64, -legAngle * 0.85)
    const wrist = limbEnd(elbow, 0.58, -legAngle * 0.85 - 0.22)
    bone(armTop, elbow, 0.125, 0.13, 1)
    bone(elbow, wrist, 0.092, 0.1)
    ellipsoid(add(wrist, [0, -0.1, 0]), [0.095, 0.15, 0.08])
  }
  return parts
}

export function createPeople(canvas, control) {
  const ctx = canvas.getContext("2d", { alpha: true })
  if (!ctx) {
    control.hidden = true
    return () => {}
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)")
  const pointer = { x: 0, y: 0 }
  let width = 0,
    height = 0,
    columns = 0,
    rows = 0,
    depth,
    shade,
    material
  let cellX = 6,
    cellY = 8,
    paused = false,
    visible = true,
    elapsed = 0,
    last = 0
  let inView = true
  const figures = [
    { x: 0.145, y: 0.42, size: 0.48, turn: 2.4, phase: 0.5, drift: 1.1 },
    { x: 0.85, y: 0.43, size: 0.57, turn: -1.05, phase: 2.2, drift: 2.4 },
    { x: 0.38, y: 0.96, size: 0.4, turn: 0.7, phase: 4.0, drift: 3.3 },
    { x: 0.62, y: 0.055, size: 0.3, turn: -2.5, phase: 1.1, drift: 4.5 },
    { x: 0.98, y: 0.91, size: 0.32, turn: -1.9, phase: 3.2, drift: 5.9 },
  ]
  function resize() {
    width = canvas.clientWidth
    height = canvas.clientHeight
    const ratio = Math.min(devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    cellX = width < 760 ? 4.3 : 5.8
    cellY = width < 760 ? 6.2 : 8
    columns = Math.ceil(width / cellX)
    rows = Math.ceil(height / cellY)
    depth = new Float32Array(columns * rows)
    shade = new Float32Array(columns * rows)
    material = new Uint8Array(columns * rows)
    draw()
  }
  function draw() {
    ctx.clearRect(0, 0, width, height)
    depth.fill(-Infinity)
    shade.fill(0)
    const mobile = width < 760
    for (let f = 0; f < figures.length; f++) {
      if (mobile && f > 2) continue
      const figure = figures[f]
      const t = elapsed * 0.28 + figure.phase
      const turn = figure.turn + Math.sin(elapsed * 0.12 + f) * 0.24
      const co = Math.cos(turn),
        si = Math.sin(turn)
      let fx = figure.x,
        fy = figure.y,
        size = figure.size
      if (mobile) {
        fx = [0.03, 0.94, 0.67][f]
        fy = [0.26, 0.73, 0.98][f]
        size = [0.33, 0.37, 0.28][f]
      }
      const scale = (Math.min(height, mobile ? 860 : 1050) * size) / 3.7
      const driftX =
        Math.sin(elapsed * 0.09 + figure.drift) * (mobile ? 12 : 34)
      const centerX = width * fx + driftX + pointer.x * (f % 2 ? 9 : -9)
      const centerY =
        height * fy +
        Math.cos(elapsed * 0.11 + figure.drift) * 13 +
        pointer.y * 6
      const tilt = Math.sin(figure.drift) * 0.07
      const ct = Math.cos(tilt),
        st = Math.sin(tilt)
      for (const part of skeleton(t)) {
        const cp = Math.cos(part.angle || 0),
          sp = Math.sin(part.angle || 0)
        const stride = part.radius[1] < 0.2 ? 3 : 1
        for (let n = 0; n < samples.length; n += stride) {
          const normal = samples[n]
          const px = normal[0] * part.radius[0]
          const py = normal[1] * part.radius[1]
          const pz = normal[2] * part.radius[2]
          const x = px + part.center[0]
          const y = py * cp + pz * sp + part.center[1] - 1.75
          const z = -py * sp + pz * cp + part.center[2]
          const rx = x * co + z * si
          const rz = -x * si + z * co
          const screenX = centerX + (rx * ct - y * st) * scale
          // Slightly elevated camera: reveal shoulders, heads, and shoe surfaces.
          const screenY = centerY - (y * 0.97 + rz * 0.23) * scale
          const col = Math.floor(screenX / cellX),
            row = Math.floor(screenY / cellY)
          if (col < 0 || col >= columns || row < 0 || row >= rows) continue
          const d = rz - y * 0.2
          const index = row * columns + col
          if (d <= depth[index]) continue
          const ny = normal[1] * cp + normal[2] * sp
          const nz = -normal[1] * sp + normal[2] * cp
          const nx = normal[0] * co + nz * si
          const facing = -normal[0] * si + nz * co
          const light = Math.max(0, nx * -0.52 + ny * 0.6 + facing * 0.6)
          depth[index] = d
          shade[index] = 0.24 + (1 - light) * 0.69
          material[index] = part.style
        }
      }
    }
    ctx.font = `${cellY * 0.94}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
    ctx.textBaseline = "top"
    for (let i = 0; i < depth.length; i++) {
      if (depth[i] === -Infinity) continue
      const col = i % columns,
        row = Math.floor(i / columns)
      const x = col * cellX,
        y = row * cellY
      const value = shade[i]
      // Quiet gray cells echo the reference's reversed ASCII texture.
      const noise = ((col * 13 + row * 7) % 11) / 11
      const dark = value > 0.64
      const alpha = 0.19 + value * 0.52
      ctx.fillStyle = `rgba(65,72,62,${dark ? alpha : alpha * 0.32})`
      ctx.fillRect(x, y, cellX - 0.7, cellY - 0.7)
      ctx.fillStyle = dark
        ? `rgba(250,251,249,${0.68 + noise * 0.25})`
        : `rgba(52,60,49,${0.25 + value * 0.58})`
      const character =
        glyphs[
          Math.min(glyphs.length - 1, Math.floor(value * (glyphs.length - 1)))
        ]
      ctx.fillText(character, x + 0.35, y - 0.1)
    }
    // Sparse source marks keep the empty graph field connected to the figures.
    ctx.fillStyle = "rgba(90,103,82,.17)"
    ctx.font = `${cellY}px ui-monospace,monospace`
    for (let i = 0; i < (mobile ? 24 : 65); i++) {
      const x = (i * 137.37 + 53) % width
      const y = (i * 193.53 + 91) % height
      if (
        x > width * 0.24 &&
        x < width * 0.76 &&
        y > height * 0.2 &&
        y < height * 0.8
      )
        continue
      ctx.fillText(i % 3 ? "·" : "+", x, y)
    }
  }
  function tick(time, delta) {
    if (paused || reduced.matches || !visible || !inView) return
    elapsed += Math.min(delta, 50) / 1000
    if (time - last < 1 / 24) return
    last = time
    draw()
  }
  const updateControl = () => {
    control.setAttribute("aria-pressed", String(paused))
    control.setAttribute(
      "aria-label",
      paused ? "Play animation" : "Pause animation"
    )
    control.querySelector("span").textContent = paused
      ? "Play motion"
      : "Pause motion"
    control
      .querySelector("path")
      .setAttribute("d", paused ? "M3 2l7 4-7 4z" : "M3 2h2v8H3zm4 0h2v8H7z")
  }
  function toggle() {
    paused = !paused
    updateControl()
  }
  function preference() {
    // A changed OS preference resets to a still frame and disables the motion control.
    control.hidden = reduced.matches
    draw()
  }
  function visibility() {
    visible = !document.hidden
  }
  function move(event) {
    if (reduced.matches || paused || event.pointerType === "touch") return
    pointer.x = event.clientX / width - 0.5
    pointer.y = event.clientY / height - 0.5
  }
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  const intersection = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting
  })
  intersection.observe(canvas)
  reduced.addEventListener("change", preference)
  document.addEventListener("visibilitychange", visibility)
  window.addEventListener("pointermove", move, { passive: true })
  control.addEventListener("click", toggle)
  resize()
  preference()
  gsap.ticker.add(tick)
  return () => {
    gsap.ticker.remove(tick)
    observer.disconnect()
    intersection.disconnect()
    reduced.removeEventListener("change", preference)
    document.removeEventListener("visibilitychange", visibility)
    window.removeEventListener("pointermove", move)
    control.removeEventListener("click", toggle)
  }
}
