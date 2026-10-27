// Build-time use of the MIT-licensed Anatomy skill. No kit code ships at runtime.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { buildReferenceArt } from "./build-reference-art.mjs"
import { buildMilestoneArt } from "./build-milestone-art.mjs"
import { buildCollection } from "./build-empty-state-collection.mjs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const skill =
  process.env.ANATOMY_SKILL_PATH ?? join(homedir(), ".agents/skills/anatomy")
const k = await import(pathToFileURL(join(skill, "kit/iso-kit.mjs")).href)
const G = await import(pathToFileURL(join(skill, "kit/lathe.mjs")).href)
const A = await import(pathToFileURL(join(skill, "kit/audit.mjs")).href)
const out = join(root, "apps/forge/src/components/illustrations")
const qa = join(root, "docs/qa/empty-state-art")
await mkdir(out, { recursive: true })
await mkdir(qa, { recursive: true })

const width = 260,
  height = 208
const common = k.fitProjection(
  k.boxCorners({ x: -62, y: -54, w: 124, d: 120, r: 0 }, -9, 84),
  width,
  height,
  { pad: 20, azimuth: 40, elevation: 30 }
)
function scene(bounds, top) {
  const points = k
    .boxCorners(bounds, -9, top)
    .map((point) => k.iso(point, common))
  const xs = points.map((p) => p[0]),
    ys = points.map((p) => p[1])
  return {
    ...common,
    origin: [
      common.origin[0] + width / 2 - (Math.min(...xs) + Math.max(...xs)) / 2,
      common.origin[1] + height / 2 - (Math.min(...ys) + Math.max(...ys)) / 2,
    ],
  }
}
function drawing(P) {
  let count = 0
  const parts = []
  const S = (plan, z, h, tone = "mid", lit = false, extra = "") => {
    count++
    return k.solidSvg(k.slabOf(plan, z, h, P, 3, Math.min(0.65, h / 3)), {
      tone,
      crease: "faint",
      lit,
      inner: extra,
    })
  }
  const box = (x, y, w, d, z, h, tone = "mid", lit = false, extra = "") =>
    S({ x, y, w, d, r: Math.min(1, w / 3, d / 3) }, z, h, tone, lit, extra)
  const L = (d, tone = "lo", free = false) => k.lineSvg(d, { tone, free })
  const dots = (points, tone = "mid") =>
    k.dotsSvg(
      points.map((point) => k.iso(point, P)),
      { size: 0.5, tone }
    )
  function base(plan) {
    parts.push(`<path class="iso-halo" d="${k.haloOf(plan, -9, 6, P)}"/>`)
    for (const [x, y] of k
      .corners(plan, 8)
      .sort((a, b) => k.depthOf([...a, -7], P) - k.depthOf([...b, -7], P))) {
      parts.push(box(x - 4, y - 4, 8, 8, -9, 2, "lo"))
      parts.push(box(x - 3.2, y - 3.2, 6.4, 6.4, -7, 3, "lo"))
    }
    parts.push(S(plan, -4, 5, "lo"))
    parts.push(L(k.planOutline(k.insetPlan(plan, 3), 1, P, 3), "faint"))
    parts.push(dots(k.corners(plan, 5).map(([x, y]) => [x, y, 1.1])))
  }
  const solid = (paths, tone = "mid", lit = false) => {
    count++
    return k.solidSvg(paths, { tone, lit, crease: "faint" })
  }
  return { parts, S, box, L, dots, base, solid, count: () => count }
}

function projects() {
  const P = scene({ x: -48, y: -38, w: 96, d: 106, r: 2 }, 82)
  const { parts, S, box, L, dots, base, count } = drawing(P)
  base({ x: -48, y: -38, w: 96, d: 80, r: 3 })
  parts.push(box(-43, -33, 86, 67, 1, 4, "lo"))
  parts.push(box(-43, -34, 86, 3, 5, 73, "lo"))
  parts.push(box(-44, -34, 3, 70, 5, 73, "mid"))
  // The far (-x) jamb is behind the tray and folders, not in front of them.
  parts.push(box(-44, 36, 4, 3, 5, 73, "mid"))
  const drawerFronts = []
  for (const z of [7, 30, 53]) {
    for (const x of [-40, 37]) {
      parts.push(box(x, -29, 3, 62, z - 2, 2, "lo"))
      parts.push(L(k.lineOnTop([x + 1.5, -29], [x + 1.5, 33], z, P), "faint"))
    }
    const open = z === 53
    const front = open ? 54 : 35
    const back = front - 64
    const drawer = []
    drawer.push(box(-39, back, 78, 64, z, 2, open ? "hi" : "lo"))
    drawer.push(box(-39, back, 2, 64, z + 2, 15, "mid"))
    drawer.push(box(37, back, 2, 64, z + 2, 15, "mid"))
    drawer.push(box(-37, back, 74, 2, z + 2, 15, "lo"))
    if (open) {
      for (let i = 0; i < 4; i++) {
        const y = front - 21 + i * 4.5
        drawer.push(box(-33, y, 66, 0.9, z + 2, 19 - i * 1.5, "mid"))
        drawer.push(
          box(
            -28 + i * 13,
            y,
            13,
            0.9,
            z + 21 - i * 1.5,
            3,
            i === 3 ? "hi" : "mid"
          )
        )
        const rules = [9, 6]
          .map((length, j) =>
            k.segment(
              [-25 + i * 13, y + 0.95, z + 22.6 - i * 1.5 - j],
              [-25 + i * 13 + length, y + 0.95, z + 22.6 - i * 1.5 - j],
              P
            )
          )
          .join("")
        drawer.push(L(rules, "lo", true))
      }
    }
    // The tray sits inside the carcass. Its extended front is outside the
    // case's y=39 front plane throughout its full y=54..59 motion range.
    parts.push(
      `<g${open ? ' data-part="project-drawer"' : ""}>${drawer.join("")}</g>`
    )
    drawer.length = 0
    drawer.push(box(-40, front, 80, 2.5, z, 19, open ? "hi" : "mid", open))
    drawer.push(box(-26, front + 2.5, 20, 0.9, z + 7, 7, "lo"))
    drawer.push(box(-24.5, front + 3.4, 17, 0.3, z + 8.2, 4.5, "mid"))
    const rules = [11, 7]
      .map((length, j) =>
        k.segment(
          [-23, front + 3.8, z + 11.7 - j * 1.5],
          [-23 + length, front + 3.8, z + 11.7 - j * 1.5],
          P
        )
      )
      .join("")
    drawer.push(L(rules, "lo", true))
    for (const x of [10, 28])
      drawer.push(box(x, front + 2.5, 3, 4, z + 8, 3, "mid"))
    drawer.push(box(10, front + 6.5, 21, 2.5, z + 8, 3, "hi"))
    drawer.push(
      dots([
        [-35, front + 2.6, z + 4],
        [35, front + 2.6, z + 4],
        [-35, front + 2.6, z + 15],
        [35, front + 2.6, z + 15],
      ])
    )
    ;(open ? drawerFronts : parts).push(
      `<g${open ? ' data-part="project-drawer"' : ""}>${drawer.join("")}</g>`
    )
  }
  parts.push(box(41, -34, 3, 70, 5, 73, "mid"))
  parts.push(box(44, -25, 0.6, 52, 17, 48, "lo"))
  const faceLoop = (y, z, w, h) =>
    k.pathOf(
      [
        [44.7, y, z],
        [44.7, y + w, z],
        [44.7, y + w, z + h],
        [44.7, y, z + h],
      ].map((point) => k.iso(point, P)),
      true
    )
  parts.push(L(faceLoop(-22, 20, 46, 42), "faint"))
  for (let slot = 0; slot < 6; slot++)
    parts.push(L(faceLoop(-17 + slot * 6.5, 49, 2, 8), "lo"))
  for (const z of [28, 31, 34])
    parts.push(box(44.6, -17, 0.35, 35, z, 0.8, "lo"))
  parts.push(
    dots(
      [
        [-22, 21],
        [23, 21],
        [-22, 61],
        [23, 61],
      ].map(([y, z]) => [44.8, y, z])
    )
  )
  parts.push(box(40, 36, 4, 3, 5, 73, "mid"))
  parts.push(S({ x: -46, y: -36, w: 92, d: 74, r: 2 }, 78, 4, "hi"))
  parts.push(S({ x: -41, y: -31, w: 82, d: 64, r: 1 }, 82, 0.35, "lo"))
  parts.push(
    L(
      k.planOutline({ x: -38, y: -28, w: 76, d: 58, r: 1 }, 82.4, P, 3),
      "faint"
    )
  )
  parts.push(
    dots([
      [-42, -32, 82.5],
      [42, -32, 82.5],
      [-42, 34, 82.5],
      [42, 34, 82.5],
    ])
  )
  parts.push(...drawerFronts)
  const [dx, dy] = k.iso([0, 5, 0], { ...P, origin: [0, 0] })
  return {
    body: parts.join(""),
    parts: count(),
    move: `${dx.toFixed(2)}px ${dy.toFixed(2)}px`,
  }
}

function views() {
  const P = scene({ x: -60, y: -48, w: 120, d: 98, r: 3 }, 28)
  const { parts, S, box, L, dots, base, count } = drawing(P)
  base({ x: -60, y: -48, w: 120, d: 98, r: 4 })
  parts.push(S({ x: -56, y: -44, w: 112, d: 87, r: 3 }, 1, 8, "mid"))
  parts.push(S({ x: -45, y: -35, w: 90, d: 61, r: 1 }, 9, 0.7, "lo"))
  for (const y of [-39, 28]) {
    parts.push(box(-49, y, 98, 3, 9, 4, "mid"))
    for (const x of [-52, 49]) parts.push(box(x, y - 1, 3, 5, 9, 6, "mid"))
    parts.push(L(k.lineOnTop([-49, y + 1.5], [49, y + 1.5], 13, P), "lo"))
  }
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 3; col++) {
      const x = -38 + col * 26,
        y = -28 + row * 26
      parts.push(box(x, y, 22, 20, 9.7, 0.65, "mid"))
      parts.push(box(x + 2, y - 2.5, 8, 2.5, 9.7, 0.65, "lo"))
      parts.push(
        L(
          [0, 1, 2]
            .map((line) =>
              k.lineOnTop(
                [x + 4, y + 5 + line * 4],
                [x + (line === 2 ? 13 : 18), y + 5 + line * 4],
                10.4,
                P
              )
            )
            .join(""),
          "lo",
          true
        )
      )
      parts.push(dots([[x + 3, y + 16, 10.5]], "lo"))
    }
  const frame = []
  for (const x of [9, 41])
    for (const y of [-39, 25]) frame.push(box(x, y, 5, 6, 13, 3, "mid"))
  frame.push(box(10, -33, 3, 58, 16, 3, "hi", true))
  frame.push(box(42, -33, 3, 58, 16, 3, "hi", true))
  frame.push(box(10, -36, 35, 3, 16, 3, "hi", true))
  frame.push(box(10, 25, 35, 3, 16, 3, "hi", true))
  for (const x of [20, 34]) frame.push(box(x, 28, 3, 3, 16, 5, "mid"))
  frame.push(box(20, 28, 17, 3, 21, 2.5, "hi"))
  frame.push(
    dots(
      [
        [11.5, -34.5, 19.1],
        [43.5, -34.5, 19.1],
        [11.5, 26.5, 19.1],
        [43.5, 26.5, 19.1],
      ],
      "hi"
    )
  )
  parts.push(`<g data-part="view-selector">${frame.join("")}</g>`)
  for (let i = 0; i < 3; i++) {
    const x = -42 + i * 25,
      y = 32
    parts.push(box(x, y, 18, 7, 9, 0.7, "lo"))
    for (const yy of [y, y + 6]) parts.push(box(x, yy, 18, 1, 9.7, 0.6, "lo"))
    parts.push(box(x + [2, 8, 4][i], y + 1, 6, 5, 9.7, 2.5, "mid"))
    parts.push(box(x + [4.5, 10.5, 6.5][i], y + 2, 1, 3, 12.2, 0.3, "hi"))
  }
  parts.push(box(-37, 43, 23, 0.6, 3, 4, "lo"))
  parts.push(L(k.segment([-34, 43.7, 5], [-18, 43.7, 5], P), "lo", true))
  parts.push(
    dots(
      k
        .corners({ x: -56, y: -44, w: 112, d: 87, r: 3 }, 5)
        .map(([x, y]) => [x, y, 9.1])
    )
  )
  const [dx, dy] = k.iso([-26, 0, 0], { ...P, origin: [0, 0] })
  return {
    body: parts.join(""),
    parts: count(),
    move: `${dx.toFixed(2)}px ${dy.toFixed(2)}px`,
  }
}

const figures = {
  milestones: buildMilestoneArt(k, G, A, scene),
  ...buildReferenceArt(k, G, A, scene),
  ...buildCollection(k, G, drawing, scene),
  projects: projects(),
  views: views(),
}
await writeFile(
  join(out, "empty-state-art.generated.ts"),
  `// Generated by scripts/illustrations/build-empty-state-art.mjs. Do not edit paths.\nexport const emptyStateArt = ${JSON.stringify(figures)} as const\n`
)
const css = await readFile(join(out, "empty-state-art.css"), "utf8")
const ts = await import("typescript")
const motion = ts.transpileModule(
  await readFile(join(out, "empty-state-motion.ts"), "utf8"),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  }
).outputText
const motionScript = `${motion}
for(const svg of document.querySelectorAll('svg[data-kind]')) mountEmptyStateMotion(svg, svg.dataset.kind)`

const markup = Object.entries(figures)
  .map(
    ([kind, figure]) =>
      `<article class="iso-plate empty-state-content" data-figure="${kind}"><svg class="empty-state-art" data-kind="${kind}" style="--art-move:${figure.move};--art-x:${figure.move.split(" ")[0]};--art-y:${figure.move.split(" ")[1]}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${kind}">${figure.body}</svg><h2>${kind}</h2><p>${figure.parts} solid parts · Theme-aware isometric SVG.</p><button>Create ${kind}</button></article>`
  )
  .join("")
for (const theme of ["dark", "light"])
  await writeFile(
    join(qa, `gallery-${theme}.html`),
    `<!doctype html><html class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{--background:#fff;--foreground:#18181b}.dark{--background:#111;--foreground:#eee}body{margin:0;background:var(--background);color:var(--foreground);font:13px system-ui}main{display:flex;flex-wrap:wrap;gap:48px;padding:32px}.iso-plate{width:300px;max-width:100%;box-sizing:border-box;padding:24px;border:1px solid #8883}button{background:none;color:inherit;border:1px solid #8886;border-radius:20px;padding:6px 14px}h2{text-transform:capitalize;font-size:14px}${css}</style></head><body><main>${markup}</main><script type="module">${motionScript}</script></body></html>`
  )
// Focused plates for reviewing the milestone at product size and 4×.
for (const theme of ["dark", "light"]) {
  const figure = figures.milestones
  for (const zoom of [1, 4]) {
    const artWidth = width * zoom,
      artHeight = height * zoom
    await writeFile(
      join(qa, `milestone-${theme}${zoom === 4 ? "-4x" : ""}.html`),
      `<!doctype html><html class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--background:#fff;--foreground:#18181b}.dark{--background:#111;--foreground:#eee}body{margin:0;background:var(--background);color:var(--foreground);font:13px system-ui}main{padding:24px}.iso-plate{width:${artWidth + 48}px;max-width:100%;box-sizing:border-box;padding:24px;border:1px solid #8883;border-radius:14px}header,footer{display:flex;justify-content:space-between;gap:24px;color:#888;font-size:11px}.empty-state-art{width:${artWidth}px!important;height:${artHeight}px!important;max-width:100%;margin:12px auto}.caption{max-width:310px;color:#888;line-height:1.6}button{background:none;color:inherit;border:1px solid #8886;border-radius:20px;padding:6px 12px}${css}</style></head><body><main><article class="iso-plate empty-state-content"><header><span>Fig 14</span><span>Milestone checkpoint</span></header><svg class="empty-state-art" data-kind="milestones" style="--art-move:${figure.move};--art-x:${figure.move.split(" ")[0]};--art-y:${figure.move.split(" ")[1]}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Milestone checkpoint station">${figure.body}</svg><footer><span>Hover or focus to lift the gate</span><span data-readout>0 issues</span></footer><p class="caption">A raised checkpoint marker and an empty intake tray. The gate stays in its guides as it lifts; no work has been assigned.</p><button>Create new issue</button></article></main><script type="module">${motionScript}</script></body></html>`
    )
  }
}
console.log(
  Object.fromEntries(
    Object.entries(figures).map(([kind, figure]) => [
      kind,
      `${figure.parts} solid parts`,
    ])
  )
)
