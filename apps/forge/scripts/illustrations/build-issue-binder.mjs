/** An open binder: punched paper follows the semicircular rings through a full turn. */
export function buildIssueBinder(k, A, scene, G) {
  const bounds = { x: -58, y: -44, w: 118, d: 88, r: 2 }
  const P = scene(bounds, 14)
  const spineZ = 2.75
  const maxAngle = Math.PI
  const holes = [-26, 0, 26]
  const line = (d, tone = "lo", free = false) => k.lineSvg(d, { tone, free })
  function pose(phase) {
    const R = A.recorder(P)
    const ground = []
    const angle = phase * maxAngle
    const pageFrame = {
      o: [0, 0, spineZ],
      a: [-Math.sin(angle), 0, Math.cos(angle)],
      u: [Math.cos(angle), 0, Math.sin(angle)],
      v: [0, 1, 0],
    }
    const pagePoint = ([x, y]) => [
      x * Math.cos(angle),
      y,
      spineZ + x * Math.sin(angle),
    ]
    const print = (points, tone = "lo", closed = false, free = false) =>
      line(
        k.pathOf(
          points.map((point) => k.iso(pagePoint(point), P)),
          closed
        ),
        tone,
        free
      )
    function put(name, paths, shapes, at, tone = "mid", inner = "") {
      for (const shape of shapes) {
        shape.name = name
        R.solid(shape)
      }
      R.put({
        name,
        at,
        piece: "binder",
        move: [0, 0, 0],
        shapes,
        svg:
          typeof paths === "string"
            ? paths
            : k.solidSvg(paths, { tone, crease: "faint", inner }),
      })
      return shapes[0]
    }
    function slab(
      name,
      x,
      y,
      w,
      d,
      z,
      h,
      tone = "mid",
      inner = "",
      radius = 0.5
    ) {
      const plan = { x, y, w, d, r: Math.min(radius, w / 2, d / 2) }
      return put(
        name,
        k.slabOf(plan, z, h, P, 5, Math.min(h / 3, 0.5)),
        [A.slab(plan, z, h, {}, 5)],
        [x + w / 2, y + d / 2, z + h / 2],
        tone,
        inner
      )
    }
    const rules = (x, y, z, widths) =>
      widths
        .map((w, i) =>
          line(
            k.lineOnTop([x, y + i * 3.2], [x + w, y + i * 3.2], z, P),
            "lo",
            true
          )
        )
        .join("")
    for (const [name, x, w] of [
      ["left cover", -58, 55],
      ["spine", -3, 6],
      ["right cover", 3, 55],
    ]) {
      const plan = { x, y: -44, w, d: 88, r: 1.5 }
      ground.push(
        slab(
          name,
          x,
          -44,
          w,
          88,
          0,
          1.2,
          "lo",
          line(k.sideSeam(plan, 0.6, P, 5), "faint"),
          1.5
        )
      )
    }
    for (const [i, x] of [-5, 1].entries())
      slab(`cloth hinge ${i}`, x, -43, 4, 86, 1.2, 0.25, "lo")
    for (const [i, [x, y, direction]] of [
      [-58, -44, 1],
      [52, -44, 1],
      [-58, 42.4, -1],
      [52, 42.4, -1],
    ].entries()) {
      slab(`corner cap ${i}`, x, y, 6, 1.6, 1.2, 0.25, "mid")
      slab(
        `corner return ${i}`,
        x < 0 ? x : x + 4.4,
        direction > 0 ? y + 1.6 : y - 4.4,
        1.6,
        4.4,
        1.2,
        0.25,
        "mid"
      )
    }
    for (let i = 0; i < 3; i++) {
      slab(
        `left leaf ${i}`,
        -53 + i * 0.2,
        -39 + i * 0.15,
        45 - i * 0.2,
        78 - i * 0.15,
        1.2 + i * 0.4,
        0.4,
        i === 2 ? "mid" : "lo"
      )
      slab(`divider ${i}`, 8, -40, 47, 80, 1.2 + i * 0.45, 0.45, "mid")
      slab(
        `index tab ${i}`,
        55,
        -27 + i * 22,
        5,
        11,
        1.2 + i * 0.45,
        0.45,
        "hi",
        rules(56.2, -24 + i * 22, 1.65 + i * 0.45, [2.5, 2.5])
      )
    }
    // A stitched cover pocket and its identification card.
    slab(
      "cover pocket",
      -49,
      -34,
      36,
      64,
      2.4,
      0.12,
      "lo",
      line(
        k.planOutline({ x: -47, y: -32, w: 32, d: 60, r: 1 }, 2.52, P, 5),
        "faint"
      )
    )
    slab(
      "pocket label",
      -44,
      -23,
      25,
      17,
      2.52,
      0.1,
      "mid",
      rules(-41, -19, 2.62, [17, 12, 15])
    )
    // Paper is supported along the binding edge and by the dividers at rest.
    for (const [i, [y, d]] of [
      [-40, 11.5],
      [-23.5, 21],
      [2.5, 21],
      [28.5, 11.5],
    ].entries())
      slab(`binding support ${i}`, 0, y, 1, d, 1.2, 1.55, "lo")
    for (const [i, y] of holes.entries()) {
      slab(`ring mount ${i}`, -6.5, y - 2.5, 13, 5, 1.45, 1.3, "mid")
      for (const [j, x] of [-3, 3].entries())
        slab(
          `mount rivet ${i}.${j}`,
          x - 0.55,
          y - 0.55,
          1.1,
          1.1,
          spineZ,
          0.3,
          "hi",
          line(
            k.lineOnTop([x - 0.35, y], [x + 0.35, y], spineZ + 0.3, P),
            "lo"
          ),
          0.55
        )
      for (const [j, x] of [-5.3, 5.3].entries())
        slab(
          `ring foot ${i}.${j}`,
          x - 0.7,
          y - 1,
          1.4,
          2,
          spineZ - 0.2,
          0.2,
          "mid"
        )
      // Split at the paper plane as well as every 15 degrees. Each recorded
      // wedge is convex; no ring geometry is hidden inside a stand-in hull.
      const cuts = [
        ...new Set([
          0,
          angle,
          ...Array.from({ length: 13 }, (_, j) => (j * Math.PI) / 12),
        ]),
      ].sort((a, b) => a - b)
      const F = { o: [0, y, spineZ], a: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] }
      for (let j = 0; j < cuts.length - 1; j++) {
        const lo = cuts[j],
          hi = cuts[j + 1]
        if (hi - lo < 1e-6) continue
        const polar = (r, t) => [r * Math.cos(t), r * Math.sin(t)]
        const polygon = [
          polar(4.7, lo),
          polar(5.9, lo),
          polar(5.9, hi),
          polar(4.7, hi),
        ]
        const paths = G.prismOf(F, polygon, -0.6, 0.6, P)
        // Radial joins are construction boundaries, not seams in the metal.
        paths.outline = ""
        paths.crease = ""
        put(
          `ring arc ${i}.${j}`,
          paths,
          [A.prism(F, polygon, -0.6, 0.6)],
          [
            5.3 * Math.cos((lo + hi) / 2),
            y,
            spineZ + 5.3 * Math.sin((lo + hi) / 2),
          ],
          "hi"
        )
      }
    }

    // The page's punched slots are real holes. Record its ten material panels,
    // but render one continuous paper surface so panel joins never become seams.
    const panels = []
    let y = -40
    for (const hole of holes) {
      panels.push([1, y, 53, hole - 0.7 - y])
      panels.push([1, hole - 0.7, 3.65, 1.4], [5.95, hole - 0.7, 48.05, 1.4])
      y = hole + 0.7
    }
    panels.push([1, y, 53, 40 - y])
    const shapes = panels.map(([x, y, w, d]) =>
      A.prism(
        pageFrame,
        [
          [x, y],
          [x + w, y],
          [x + w, y + d],
          [x, y + d],
        ],
        0,
        0
      )
    )
    const holePaths = holes
      .map((y) =>
        k.pathOf(
          [
            [4.65, y - 0.7],
            [5.95, y - 0.7],
            [5.95, y + 0.7],
            [4.65, y + 0.7],
          ].map((p) => k.iso(pagePoint(p), P)),
          true
        )
      )
      .join("")
    const outline =
      k.pathOf(
        [
          [1, -40],
          [54, -40],
          [54, 40],
          [1, 40],
        ].map((p) => k.iso(pagePoint(p), P)),
        true
      ) + holePaths
    let ink =
      print(
        [
          [12, -30],
          [43, -30],
        ],
        "mid",
        false,
        true
      ) +
      print(
        [
          [12, -25],
          [32, -25],
        ],
        "lo",
        false,
        true
      )
    for (let i = 0; i < 4; i++) {
      const yy = -14 + i * 12
      ink += print(
        [
          [12, yy],
          [16, yy],
          [16, yy + 4],
          [12, yy + 4],
        ],
        i === 0 ? "hi" : "lo",
        true
      )
      ink += print(
        [
          [21, yy + 1],
          [45 - (i % 2) * 5, yy + 1],
        ],
        "mid",
        false,
        true
      )
      ink += print(
        [
          [21, yy + 5],
          [36, yy + 5],
        ],
        "lo",
        false,
        true
      )
    }
    const svg =
      `<path class="iso-top" fill-rule="evenodd" d="${outline}"/>` +
      `<path class="iso-line" data-tone="hi" d="${outline}"/>${ink}`
    put(
      "issue sheet",
      `<g class="issue-sheet">${svg}</g>`,
      shapes,
      pagePoint([27.5, 0])
    )
    return { R, ground, phase }
  }

  const phases = Array.from({ length: 91 }, (_, i) => i / 90)
  const poses = phases.map(pose)
  // The page passes through the loops' openings. Their painter order changes
  // during the turn, so solve the moving assembly at every displayed pose.
  for (const { R } of poses)
    A.settle(R, P, { states: [0], step: 0.18, tolerance: 0.01, least: 0.02 })
  const movingNames = new Set(
    poses.flatMap(({ R }) =>
      R.items
        .filter(
          (item) =>
            item.name === "issue sheet" || item.name.startsWith("ring arc")
        )
        .map((item) => item.name)
    )
  )
  // Keep any stationary piece that occludes the paper in the moving assembly,
  // too. A static background is safe only when it is behind every moving part.
  let changed = true
  while (changed) {
    changed = false
    for (const { R } of poses) {
      for (const pair of R.settled.overlaps.pairs) {
        const front =
          pair.front[0].area >= R.settled.overlaps.least ? pair.a : pair.b
        const back = front === pair.a ? pair.b : pair.a
        if (
          movingNames.has(R.items[back].name) &&
          !movingNames.has(R.items[front].name)
        ) {
          movingNames.add(R.items[front].name)
          changed = true
        }
      }
    }
  }
  const moving = (item) => movingNames.has(item.name)
  const stationary = [...poses[0].R.items]
    .filter((item) => !moving(item))
    .sort((a, b) => a.key - b.key)
  const background = stationary.map((item) => item.svg).join("")
  const frames = []
  for (const { R, ground, phase } of poses) {
    const live = [...R.items].filter(moving).sort((a, b) => a.key - b.key)
    // Audit the actual final SVG order, including its background/animation split.
    const names = [...stationary, ...live].map((item) => item.name)
    R.items.forEach((item) => (item.key = names.indexOf(item.name)))
    if (process.argv.includes("--audit")) {
      console.log(`Issue binder: ${(phase * 180).toFixed(0)} degree page turn`)
      A.auditOrExit(R, P, {
        ground: (shape) => ground.includes(shape),
        frames: [0],
      })
    }
    frames.push(live.map((item) => item.svg).join(""))
  }
  const encoded = JSON.stringify(frames)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
  return {
    body:
      `<path class="iso-halo" d="${k.haloOf(bounds, -1, 7, P)}"/>` +
      background +
      `<g data-motion="issue-page" data-page-frames="${encoded}">${frames[0]}</g>`,
    parts: 47,
    move: "0px 0px",
  }
}
