// A procedural walking human, expressed as a cloud of spheres in body space.
// Axes: r = the person's right, u = up, f = forward. Units are metres.
// The gait plants each foot on the ground for the whole stance phase, so a body
// that advances one stride per cycle never slides.

const TAU = Math.PI * 2
export const SKIN = 0
export const HAIR = 1
export const TOP = 2
export const BOTTOM = 3
export const SHOE = 4
export const BAG = 5
export const MAX_SPHERES = 320

const STANCE = 0.62 // share of the cycle a foot spends on the ground
const TORSO_DEPTH = [
  [0, 0.062],
  [0.32, 0.054],
  [0.72, 0.066],
  [1, 0.048],
]
const SKIN_TONES = [
  [214, 190, 170],
  [198, 172, 150],
  [170, 136, 110],
  [128, 96, 74],
  [92, 68, 54],
]
const HAIR_TONES = [
  [36, 32, 28],
  [24, 24, 26],
  [66, 50, 36],
  [120, 96, 64],
  [150, 148, 144],
]
const TOP_TONES = [
  [96, 104, 124],
  [128, 108, 84],
  [104, 118, 100],
  [70, 72, 74],
  [176, 164, 144],
  [112, 98, 116],
  [205, 203, 196],
]
const BOTTOM_TONES = [
  [52, 54, 58],
  [74, 68, 60],
  [88, 94, 104],
  [40, 42, 40],
  [120, 112, 98],
]
const SHOE_TONES = [
  [30, 30, 30],
  [222, 220, 214],
  [88, 64, 44],
]
const BAG_TONES = [
  [60, 66, 58],
  [130, 80, 60],
  [44, 46, 52],
]

const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const frac = (v) => v - Math.floor(v)
const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const mix = (a, b, t) => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
]
// Rotate a point in the ground plane about the vertical axis.
const turn = (r, f, angle) => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [r * c + f * s, -r * s + f * c]
}
function profile(keys, t) {
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const span = keys[i][0] - keys[i - 1][0]
      return lerp(keys[i - 1][1], keys[i][1], (t - keys[i - 1][0]) / span)
    }
  }
  return keys[keys.length - 1][1]
}

export function createTraits(rand) {
  const pick = (list) => list[Math.floor(rand() * list.length)]
  const feminine = rand() < 0.5
  const widths = feminine
    ? { hip: 0.094, waist: 0.066, chest: 0.086, shoulder: 0.096 }
    : { hip: 0.086, waist: 0.078, chest: 0.098, shoulder: 0.112 }
  const coat = rand() < 0.3
  const skirt = feminine && !coat && rand() < 0.35
  const backpack = rand() < 0.3
  const jitter = new Float32Array(MAX_SPHERES)
  const accent = new Uint8Array(MAX_SPHERES)
  for (let i = 0; i < MAX_SPHERES; i++) {
    jitter[i] = 0.88 + rand() * 0.2
    accent[i] = rand() < 0.04 ? 1 + Math.floor(rand() * 4) : 0
  }
  const stride = 0.66 + rand() * 0.1
  const height = feminine ? 1.58 + rand() * 0.16 : 1.7 + rand() * 0.2
  const period = 2.5 + rand() * 0.7 // seconds per stride: a slow, calm walk
  return {
    height,
    build: 0.88 + rand() * 0.3,
    shoulder: widths.shoulder,
    hip: widths.hip,
    widths: [
      [0, widths.hip],
      [0.32, widths.waist],
      [0.72, widths.chest],
      [1, widths.shoulder * 0.9],
    ],
    // 0 short, 1 long, 2 bun, 3 ponytail, 4 cropped
    hair: feminine ? pick([1, 1, 2, 3, 0]) : pick([0, 0, 0, 4, 1]),
    coat,
    skirt,
    shorts: !coat && !skirt && rand() < 0.15,
    sleeves: coat || rand() < 0.6,
    backpack,
    bag: !backpack && rand() < 0.2 ? (rand() < 0.5 ? -1 : 1) : 0,
    stride,
    period,
    speed: (stride * height) / period,
    armSwing: 0.8 + rand() * 0.4,
    colors: [
      pick(SKIN_TONES),
      pick(HAIR_TONES),
      pick(TOP_TONES),
      pick(BOTTOM_TONES),
      pick(SHOE_TONES),
      pick(BAG_TONES),
    ],
    jitter,
    accent,
  }
}

// Two-bone leg: the knee bends toward the direction of travel.
function solveKnee(hip, ankle, upper, lower) {
  let dx = ankle[0] - hip[0]
  let dy = ankle[1] - hip[1]
  let dz = ankle[2] - hip[2]
  let length = Math.hypot(dx, dy, dz)
  const reach = (upper + lower) * 0.998
  if (length > reach) {
    const k = reach / length
    dx *= k
    dy *= k
    dz *= k
    ankle[0] = hip[0] + dx
    ankle[1] = hip[1] + dy
    ankle[2] = hip[2] + dz
    length = reach
  }
  const ux = dx / length
  const uy = dy / length
  const uz = dz / length
  const kx = -ux * uz
  const ky = -uy * uz
  const kz = 1 - uz * uz
  const kl = Math.hypot(kx, ky, kz) || 1
  const along = (upper * upper - lower * lower + length * length) / (2 * length)
  const out = Math.sqrt(Math.max(0, upper * upper - along * along))
  return [
    hip[0] + ux * along + (kx / kl) * out,
    hip[1] + uy * along + (ky / kl) * out,
    hip[2] + uz * along + (kz / kl) * out,
  ]
}

// Fill `out` with the spheres of one person at `phase` (0..1 of a full stride).
export function pose(p, phase, out) {
  const data = out.data
  const mats = out.mat
  let n = 0
  const ball = (r, u, f, radius, material) => {
    if (n >= MAX_SPHERES) return
    const i = n * 4
    data[i] = r
    data[i + 1] = u
    data[i + 2] = f
    data[i + 3] = radius
    mats[n++] = material
  }
  const chain = (a, b, ra, rb, material, steps) => {
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      ball(
        lerp(a[0], b[0], t),
        lerp(a[1], b[1], t),
        lerp(a[2], b[2], t),
        lerp(ra, rb, t),
        material
      )
    }
  }

  const h = p.height
  const k = p.build
  const beat = Math.cos(TAU * phase) // +1 as the left heel strikes
  const pelvisYaw = 0.12 * beat
  const chestYaw = -0.15 * beat * p.armSwing
  const sway = -0.014 * h * Math.sin(TAU * (phase - 0.06))
  const hipH = (0.508 - 0.022 * Math.cos(2 * TAU * (phase - 0.06))) * h
  const shoulderH = hipH + 0.3 * h
  const lean = 0.03 * h

  // Legs
  const half = 0.5 * STANCE * p.stride * h
  const bare = p.skirt || p.shorts
  const legs = []
  for (const side of [-1, 1]) {
    const ph = frac(phase + (side > 0 ? 0.5 : 0))
    let forward, up, pitch
    if (ph < STANCE) {
      const t = ph / STANCE
      const heelOff = smooth(0.68, 1, t)
      // The ankle rides forward and up as the foot rolls over its ball.
      forward = half * (1 - 2 * t) + 0.033 * h * heelOff
      up = (0.04 + 0.05 * heelOff) * h
      pitch = t < 0.14 ? -0.35 * (1 - t / 0.14) : 0.7 * heelOff
    } else {
      const t = (ph - STANCE) / (1 - STANCE)
      const ease = t * t * (3 - 2 * t)
      forward = lerp(-half + 0.033 * h, half, ease)
      up = (0.04 + 0.05 * (1 - t) * (1 - t) + 0.055 * Math.sin(Math.PI * t)) * h
      pitch = lerp(0.7, -0.35, ease)
    }
    const [hr, hf] = turn(side * 0.05 * h, 0, pelvisYaw)
    const hip = [hr + sway, hipH, hf]
    const ankle = [side * 0.045 * h, up, forward]
    const knee = solveKnee(hip, ankle, 0.245 * h, 0.246 * h)
    const shinMat = bare ? SKIN : BOTTOM
    const bulk = bare ? 1 : 1.12
    chain(
      hip,
      knee,
      0.064 * k * h * (p.skirt ? 1 : 1.1),
      0.045 * k * h * bulk,
      p.skirt ? SKIN : BOTTOM,
      7
    )
    const calf = mix(knee, ankle, 0.3)
    chain(knee, calf, 0.045 * k * h * bulk, 0.047 * k * h * bulk, shinMat, 2)
    chain(
      calf,
      ankle,
      0.047 * k * h * bulk,
      (bare ? 0.028 : 0.036) * h,
      shinMat,
      5
    )
    const cp = Math.cos(pitch)
    const sp = Math.sin(pitch)
    for (const [f, u, radius] of [
      [-0.035, -0.014, 0.026],
      [0.03, -0.012, 0.027],
      [0.085, -0.02, 0.021],
      [0.125, -0.023, 0.017],
    ]) {
      ball(
        ankle[0],
        ankle[1] + (u * cp - f * sp) * h,
        ankle[2] + (f * cp + u * sp) * h,
        radius * h,
        SHOE
      )
    }
    legs.push({ hip, knee })
  }

  // Coat tails or a skirt hang between the thighs and move with them.
  if (p.coat || p.skirt) {
    const reach = p.coat ? 0.6 : 0.85
    for (let i = 1; i <= 5; i++) {
      const t = (i / 5) * reach
      const radius = (0.074 + 0.014 * t) * h * k
      chain(
        mix(legs[0].hip, legs[0].knee, t),
        mix(legs[1].hip, legs[1].knee, t),
        radius,
        radius,
        p.coat ? TOP : BOTTOM,
        3
      )
    }
  }

  // Torso: rows of spheres from the pelvis up to the shoulder line. The
  // shoulders counter-rotate against the pelvis.
  for (let i = 0; i < 9; i++) {
    const t = i / 8
    const yaw = lerp(pelvisYaw, chestYaw, smooth(0.1, 0.9, t))
    const radius = profile(TORSO_DEPTH, t) * h * k * (p.coat ? 1.1 : 1)
    const span = Math.max(0, profile(p.widths, t) * h - radius * 0.85)
    const u = hipH - 0.025 * h + t * (shoulderH - hipH + 0.015 * h)
    const material = t < 0.14 && !p.coat ? BOTTOM : TOP
    for (let j = 0; j < 5; j++) {
      const [r, f] = turn(lerp(-span, span, j / 4), 0, yaw)
      ball(r + sway * (1 - t * 0.5), u, f + lean * t, radius, material)
    }
  }

  // Arms swing against the legs, with the elbow folding on the way forward.
  const upperArm = 0.16 * h
  const foreArm = 0.145 * h
  const sleeve = p.coat ? 1.2 : 1.08
  for (const side of [-1, 1]) {
    const [sr, sf] = turn(side * p.shoulder * h, 0, chestYaw)
    const shoulder = [sr + sway * 0.5, shoulderH - 0.012 * h, sf + lean]
    const swing = side * beat * p.armSwing
    const angle = (swing > 0 ? 0.27 : 0.23) * swing
    const bend = 0.12 + 0.26 * Math.max(0, swing)
    const inward = 0.04
    const elbow = [
      shoulder[0] + side * 0.035 * h,
      shoulder[1] - Math.cos(angle) * upperArm,
      shoulder[2] + Math.sin(angle) * upperArm,
    ]
    const dir = [
      -side * inward,
      -Math.cos(angle + bend),
      Math.sin(angle + bend),
    ]
    const wrist = [
      elbow[0] + dir[0] * foreArm,
      elbow[1] + dir[1] * foreArm,
      elbow[2] + dir[2] * foreArm,
    ]
    ball(shoulder[0], shoulder[1], shoulder[2], 0.05 * k * h * sleeve, TOP)
    chain(
      shoulder,
      elbow,
      0.046 * k * h * sleeve,
      0.037 * k * h * sleeve,
      TOP,
      5
    )
    if (p.sleeves)
      chain(elbow, wrist, 0.036 * k * h * sleeve, 0.03 * k * h * sleeve, TOP, 5)
    else chain(elbow, wrist, 0.034 * k * h, 0.026 * k * h, SKIN, 5)
    for (const [reach, radius] of [
      [0.04, 0.028],
      [0.075, 0.022],
    ]) {
      ball(
        wrist[0] + dir[0] * reach * h,
        wrist[1] + dir[1] * reach * h,
        wrist[2] + dir[2] * reach * h,
        radius * h,
        SKIN
      )
    }
  }

  // Neck and head
  const neck = [sway * 0.5, shoulderH + 0.01 * h, lean + 0.004 * h]
  const head = [neck[0], neck[1] + 0.112 * h, neck[2] + 0.014 * h]
  chain(
    neck,
    [head[0], head[1] - 0.04 * h, head[2]],
    0.032 * k * h,
    0.03 * h,
    SKIN,
    2
  )
  const tilt = 0.04
  const ct = Math.cos(tilt)
  const st = Math.sin(tilt)
  const headYaw = chestYaw * 0.25
  const size = 1.06 * h
  const part = (r, u, f, radius, material) => {
    const [rr, ff] = turn(r, f * ct + u * st, headYaw)
    ball(
      head[0] + rr * size,
      head[1] + (u * ct - f * st) * size,
      head[2] + ff * size,
      radius * size,
      material
    )
  }
  part(0, 0, 0, 0.064, SKIN)
  part(0, -0.04, 0.018, 0.046, SKIN)
  part(0, -0.014, 0.066, 0.013, SKIN)
  if (p.hair === 4) part(0, 0.012, -0.01, 0.0665, HAIR)
  else part(0, 0.016, -0.016, 0.069, HAIR)
  if (p.hair === 1) {
    for (let i = 0; i <= 4; i++) {
      const t = i / 4
      part(
        0,
        lerp(-0.01, -0.15, t),
        lerp(-0.04, -0.05, t),
        lerp(0.058, 0.046, t),
        HAIR
      )
    }
    part(-0.046, -0.05, -0.004, 0.03, HAIR)
    part(0.046, -0.05, -0.004, 0.03, HAIR)
  } else if (p.hair === 2) {
    part(0, 0.07, -0.06, 0.034, HAIR)
  } else if (p.hair === 3) {
    const swing = 0.03 * Math.sin(2 * TAU * phase)
    for (let i = 0; i <= 4; i++) {
      const t = i / 4
      part(
        swing * t,
        lerp(0.02, -0.11, t),
        lerp(-0.075, -0.1, t),
        lerp(0.03, 0.018, t),
        HAIR
      )
    }
  }

  if (p.backpack) {
    for (const t of [0.5, 0.72, 0.94]) {
      for (const x of [-0.045, 0.045]) {
        const [r, f] = turn(x * h, -0.115 * h * k, chestYaw)
        ball(r + sway * 0.6, hipH + t * 0.3 * h, f + lean * t, 0.06 * h, BAG)
      }
    }
  }
  if (p.bag) {
    for (const f of [-0.04, 0.04]) {
      const [r, ff] = turn(p.bag * (p.hip + 0.045) * h, f * h, pelvisYaw)
      ball(r + sway, hipH + 0.02 * h, ff, 0.055 * h, BAG)
    }
  }
  out.count = n
  return n
}
