import { gsap } from "gsap"
import { MAX_SPHERES, createTraits, pose } from "./figure.js"

// People are posed as sphere clouds (figure.js), rasterised into a small depth
// buffer a few samples per text cell, then resolved into shaded ASCII tiles.
// Nothing is fetched: bodies, gait, and routes are all computed here.
const RAMP = ".:;t%XS8#@" // light to dark
const EDGE = "'.:;o"
const ACCENTS = [
  [196, 132, 128],
  [146, 128, 196],
  [92, 150, 142],
  [188, 146, 70],
]
const PITCH = 0.54 // camera looks down at the floor by about 31 degrees
const SIN = Math.sin(PITCH)
const COS = Math.cos(PITCH)
const SUB = 3 // depth samples per cell edge
// Light from the upper left, slightly toward the viewer (screen space, y down).
const LIGHT = [-0.5, -0.62, 0.6].map((v) => v / Math.hypot(0.5, 0.62, 0.6))

const lerp = (a, b, t) => a + (b - a) * t
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}
const hash = (a, b) => {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return v - Math.floor(v)
}
function noise(x, y) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const u = smooth(0, 1, x - xi)
  const v = smooth(0, 1, y - yi)
  return lerp(
    lerp(hash(xi, yi), hash(xi + 1, yi), u),
    lerp(hash(xi, yi + 1), hash(xi + 1, yi + 1), u),
    v
  )
}
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function createPeople(canvas, control) {
  const ctx = canvas.getContext("2d", { alpha: true })
  if (!ctx) {
    control.hidden = true
    return () => {}
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)")
  const rand = mulberry32(20261111)
  const cloud = {
    data: new Float32Array(MAX_SPHERES * 4),
    mat: new Uint8Array(MAX_SPHERES),
    count: 0,
  }
  const people = []
  let width = 0
  let height = 0
  let cell = 12
  let cols = 0
  let rows = 0
  let unit = 300 // pixels per metre at the middle of the floor
  let gain = 0.12 // how fast people grow as they approach
  let anchor = 0.8
  let zTop = -1.5
  let zBottom = 2.5
  let depth, light, codes, shadow
  let paused = false
  let visible = true
  let inView = true
  let elapsed = 0
  let last = 0

  const scaleAt = (z) => unit * (1 + gain * z)
  const feetY = (z) => height * anchor + z * SIN * scaleAt(z)
  const edgeX = (z) => width / 2 / scaleAt(z) + 0.7
  function solveZ(y) {
    let lo = -3
    let hi = 14
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (feetY(mid) < y) lo = mid
      else hi = mid
    }
    return lo
  }

  // A route is a straight walk across the floor, entering and leaving at the
  // sides. Depth is bounded so the top edge never crops a head and the bottom
  // edge never leaves less than head and shoulders.
  function route() {
    const side = rand() < 0.5 ? -1 : 1
    const z = lerp(zTop, zBottom, rand())
    const exit = clamp(z + (rand() - 0.5) * 2.2, zTop, zBottom)
    return [
      [side * edgeX(z), z],
      [-side * edgeX(exit), exit],
    ]
  }
  // Smallest distance this walk would come to anyone already on the floor.
  function clearance(walk, self) {
    let nearest = Infinity
    for (const other of people) {
      if (other === self || !other.length) continue
      for (let t = 0; t < 45; t += 0.5) {
        const a = walk.travelled + walk.speed * t
        const b = other.travelled + other.speed * t
        if (a > walk.length || b > other.length) break
        const dx =
          walk.from[0] + walk.dir[0] * a - other.from[0] - other.dir[0] * b
        const dz =
          walk.from[1] + walk.dir[1] * a - other.from[1] - other.dir[1] * b
        nearest = Math.min(nearest, Math.hypot(dx, dz))
      }
    }
    return nearest
  }
  function embark(person, midway) {
    person.traits = createTraits(rand)
    person.phase = rand()
    let best = null
    let bestGap = -1
    for (let attempt = 0; attempt < 12; attempt++) {
      const [from, to] = route()
      const length = Math.hypot(to[0] - from[0], to[1] - from[1])
      const walk = {
        from,
        length,
        dir: [(to[0] - from[0]) / length, (to[1] - from[1]) / length],
        travelled: midway ? rand() * length * 0.85 : 0,
        speed: person.traits.speed,
      }
      const gap = clearance(walk, person)
      if (gap > bestGap) {
        best = walk
        bestGap = gap
      }
      if (gap > 1.4) break
    }
    Object.assign(person, best)
    person.heading = Math.atan2(best.dir[0], best.dir[1])
  }

  function resize() {
    width = canvas.clientWidth
    height = canvas.clientHeight
    if (!width || !height) return
    const ratio = Math.min(devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    const narrow = width < 760
    unit = Math.min(height * 0.396, width / 2.1)
    gain = narrow ? 0.06 : 0.12
    anchor = narrow ? 0.62 : 0.8
    cell = clamp(Math.round(unit / 29), 7, 16)
    canvas.parentElement.style.setProperty("--cell", `${cell}px`)
    cols = Math.ceil(width / cell)
    rows = Math.ceil(height / cell)
    depth = new Float32Array(cols * rows * SUB * SUB)
    light = new Float32Array(depth.length)
    codes = new Uint16Array(depth.length)
    shadow = new Uint8Array(cols * rows)
    zTop = solveZ(height * (narrow ? 0.38 : 0.55))
    zBottom = solveZ(height * (narrow ? 1.1 : 1.28))
    const wanted = narrow ? 3 : width >= 1700 ? 5 : 4
    people.length = Math.min(people.length, wanted)
    while (people.length < wanted) {
      const person = {}
      people.push(person)
      embark(person, true)
    }
    draw()
  }

  function rasterise(person, index) {
    const z = person.from[1] + person.dir[1] * person.travelled
    const x = person.from[0] + person.dir[0] * person.travelled
    const s = scaleAt(z)
    const q = cell / SUB
    const ax = width / 2 + x * s
    const ay = feetY(z)
    const sinH = Math.sin(person.heading)
    const cosH = Math.cos(person.heading)
    const sw = cols * SUB
    const sh = rows * SUB
    const count = pose(person.traits, person.phase, cloud)
    const { data, mat } = cloud
    const { jitter, accent } = person.traits
    for (let i = 0; i < count; i++) {
      const r = data[i * 4]
      const u = data[i * 4 + 1]
      const f = data[i * 4 + 2]
      const wx = -r * cosH + f * sinH
      const wz = r * sinH + f * cosH
      // A cast shadow, thrown right and away from the viewer across the floor.
      const shadowCol = Math.floor((ax + (wx + 0.55 * u) * s) / cell)
      const shadowRow = Math.floor((ay + (wz - 0.3 * u) * SIN * s) / cell)
      if (
        shadowCol >= 0 &&
        shadowCol < cols &&
        shadowRow >= 0 &&
        shadowRow < rows
      )
        shadow[shadowRow * cols + shadowCol] = 1
      const radius = (data[i * 4 + 3] * s) / q
      const cx = (ax + wx * s) / q - 0.5
      const cy = (ay - (u * COS - wz * SIN) * s) / q - 0.5
      const cz = ((u * SIN + (wz + z) * COS) * s) / q
      const x0 = Math.max(0, Math.ceil(cx - radius))
      const x1 = Math.min(sw - 1, Math.floor(cx + radius))
      const y0 = Math.max(0, Math.ceil(cy - radius))
      const y1 = Math.min(sh - 1, Math.floor(cy + radius))
      if (x0 > x1 || y0 > y1) continue
      const r2 = radius * radius
      const inv = 1 / radius
      const tone = jitter[i]
      const code = (index << 8) | (mat[i] << 4) | accent[i]
      for (let py = y0; py <= y1; py++) {
        const dy = py - cy
        for (let px = x0; px <= x1; px++) {
          const dx = px - cx
          const d2 = dx * dx + dy * dy
          if (d2 >= r2) continue
          const dz = Math.sqrt(r2 - d2)
          const k = py * sw + px
          if (cz + dz <= depth[k]) continue
          depth[k] = cz + dz
          const facing = (dx * LIGHT[0] + dy * LIGHT[1] + dz * LIGHT[2]) * inv
          light[k] = (0.2 + 0.8 * Math.max(0, facing * 0.72 + 0.28)) * tone
          codes[k] = code
        }
      }
    }
  }

  function draw() {
    if (!depth) return
    ctx.clearRect(0, 0, width, height)
    depth.fill(-Infinity)
    shadow.fill(0)
    for (let i = 0; i < people.length; i++) rasterise(people[i], i)
    ctx.font = `600 ${Math.round(cell * 0.8)}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    const sw = cols * SUB
    const half = cell / 2
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        let samples = 0
        let lit = 0
        let front = -Infinity
        let code = 0
        const base = row * SUB * sw + col * SUB
        for (let sy = 0; sy < SUB; sy++) {
          for (let sx = 0; sx < SUB; sx++) {
            const k = base + sy * sw + sx
            const z = depth[k]
            if (z === -Infinity) continue
            samples++
            lit += light[k]
            if (z > front) {
              front = z
              code = codes[k]
            }
          }
        }
        const x = col * cell
        const y = row * cell
        const grain = hash(col, row)
        if (!samples) {
          if (shadow[row * cols + col]) {
            const dot = Math.max(2, Math.round(cell * 0.2))
            ctx.fillStyle = "rgba(60,68,58,.3)"
            ctx.fillRect(x + half - dot / 2, y + half - dot / 2, dot, dot)
          } else if ((row & 1) === 0 && ((col + (row >> 1)) & 1) === 0) {
            // Drifting clouds of dashes keep the empty floor alive.
            const cloudiness =
              noise(
                col * 0.05 + elapsed * 0.03,
                row * 0.075 - elapsed * 0.012
              ) *
                0.7 +
              noise(col * 0.13 - elapsed * 0.02, row * 0.17) * 0.3
            if (grain < (cloudiness - 0.66) * 4) {
              ctx.fillStyle = "rgba(32,36,33,.5)"
              ctx.fillRect(x + cell * 0.28, y + half, cell * 0.45, 1.5)
            }
          }
          continue
        }
        const cover = samples / (SUB * SUB)
        if (cover < 0.4) {
          // Silhouettes dissolve into loose marks instead of a hard outline.
          ctx.fillStyle = `rgba(32,36,33,${0.3 + cover})`
          ctx.fillText(
            EDGE[Math.floor(grain * EDGE.length)],
            x + half,
            y + half + 1
          )
          continue
        }
        const colors = people[code >> 8].traits.colors
        let [r, g, b] = colors[(code >> 4) & 15]
        const accent = code & 15
        if (accent) {
          const tint = ACCENTS[accent - 1]
          r = lerp(r, tint[0], 0.55)
          g = lerp(g, tint[1], 0.55)
          b = lerp(b, tint[2], 0.55)
        }
        const shade = 0.34 + (1.08 * lit) / samples
        r = Math.min(255, r * shade)
        g = Math.min(255, g * shade)
        b = Math.min(255, b * shade)
        const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
        const alpha =
          (0.96 - 0.5 * smooth(0.55, 0.95, lum)) * (cover < 0.75 ? 0.72 : 1)
        ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${alpha})`
        ctx.fillRect(x + 1, y + 1, cell - 1, cell - 1)
        const ink = clamp(1 - lum + (grain - 0.5) * 0.28, 0, 0.999)
        ctx.fillStyle =
          lum < 0.62 ? "rgba(255,255,255,.92)" : "rgba(32,36,33,.5)"
        ctx.fillText(
          RAMP[Math.floor(ink * RAMP.length)],
          x + half,
          y + half + 1
        )
      }
    }
  }

  function tick(time, delta) {
    if (paused || reduced.matches || !visible || !inView) return
    const dt = Math.min(delta, 50) / 1000
    elapsed += dt
    for (const person of people) {
      person.phase = (person.phase + dt / person.traits.period) % 1
      person.travelled += person.speed * dt
      if (person.travelled >= person.length) embark(person, false)
    }
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
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  const intersection = new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting
  })
  intersection.observe(canvas)
  reduced.addEventListener("change", preference)
  document.addEventListener("visibilitychange", visibility)
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
    control.removeEventListener("click", toggle)
  }
}
