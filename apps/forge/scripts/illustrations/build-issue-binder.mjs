/** An open issue binder. Its paper rotates five degrees about its bound edge. */
export function buildIssueBinder(k, A, scene) {
  const bounds = { x: -58, y: -44, w: 118, d: 88, r: 2 }
  const P = scene(bounds, 14)
  const spineZ = 2.55
  const maxAngle = (5 * Math.PI) / 180
  const holes = [-26, 0, 26]
  const line = (d, tone = "lo", free = false) => k.lineSvg(d, { tone, free })
  function pose(phase) {
    const R = A.recorder(P)
    const ground = []
    const angle = phase * maxAngle
    const pageFrame = {
      o: [1, 0, spineZ],
      a: [-Math.sin(angle), 0, Math.cos(angle)],
      u: [Math.cos(angle), 0, Math.sin(angle)],
      v: [0, 1, 0],
    }
    const pagePoint = ([x, y]) => [
      1 + (x - 1) * Math.cos(angle),
      y,
      spineZ + (x - 1) * Math.sin(angle),
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
      slab(`binding support ${i}`, 0, y, 1, d, 1.2, 1.35, "lo")
    for (const [i, y] of holes.entries()) {
      slab(`ring mount ${i}`, -6.5, y - 2.5, 13, 5, 1.45, 1.1, "mid")
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
      for (const [j, x] of [-5.5, 4.5].entries()) {
        slab(`ring foot ${i}.${j}`, x - 0.4, y - 1, 2, 2, spineZ, 0.4, "mid")
        slab(
          `ring upright ${i}.${j}`,
          x,
          y - 0.6,
          1.2,
          1.2,
          spineZ + 0.4,
          8.6,
          "hi"
        )
      }
      slab(
        `ring crown ${i}`,
        -5.5,
        y - 0.6,
        11.2,
        1.2,
        spineZ + 9,
        1.2,
        "hi",
        "",
        0.6
      )
    }

    // The page's punched slots are real holes. Record its ten material panels,
    // but render one continuous paper surface so panel joins never become seams.
    const panels = []
    let y = -40
    for (const hole of holes) {
      panels.push([1, y, 53, hole - 1.3 - y])
      panels.push([1, hole - 1.3, 2.5, 2.6], [7.5, hole - 1.3, 46.5, 2.6])
      y = hole + 1.3
    }
    panels.push([1, y, 53, 40 - y])
    const shapes = panels.map(([x, y, w, d]) =>
      A.prism(
        pageFrame,
        [
          [x - 1, y],
          [x + w - 1, y],
          [x + w - 1, y + d],
          [x - 1, y + d],
        ],
        0,
        0
      )
    )
    const holePaths = holes
      .map((y) =>
        k.pathOf(
          [
            [3.5, y - 1.3],
            [7.5, y - 1.3],
            [7.5, y + 1.3],
            [3.5, y + 1.3],
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
    put("issue sheet", svg, shapes, pagePoint([27.5, 0]))
    return { R, ground, phase }
  }

  const phases = process.argv.includes("--audit")
    ? Array.from({ length: 11 }, (_, i) => i / 10)
    : [0, 1]
  const poses = phases.map(pose)
  for (const { R } of poses)
    A.settle(R, P, { states: [0], step: 0.18, tolerance: 0.01, least: 0.02 })
  // One painter order must hold across the whole page lift, not just at rest.
  const common = A.orderKeys(poses[0].R.items, {
    ...poses[0].R.settled.overlaps,
    pairs: poses.flatMap(({ R }) => R.settled.overlaps.pairs),
  })
  for (const { R, ground, phase } of poses) {
    R.items.forEach((item, i) => (item.key = common.keys[i]))
    R.settled.solved = common
    if (process.argv.includes("--audit"))
      console.log(`Issue binder: ${(phase * 5).toFixed(1)} degree lift`)
    A.auditOrExit(R, P, {
      ground: (shape) => ground.includes(shape),
      frames: [0],
    })
  }
  const hinge = k.iso([1, 0, spineZ], P)
  const O = k.iso([0, 0, 0], { ...P, origin: [0, 0] })
  const vector = (point) =>
    k.iso(point, { ...P, origin: [0, 0] }).map((value, i) => value - O[i])
  const X = vector([1, 0, 0]),
    Y = vector([0, 1, 0]),
    Z = vector([0, 0, 1])
  const det = X[0] * Y[1] - Y[0] * X[1]
  const attrs = `data-motion="issue-page" data-page-angle="${maxAngle}" data-page-hinge="${hinge.join(" ")}" data-page-x="${X.join(" ")}" data-page-z="${Z.join(" ")}" data-page-inverse="${Y[1] / det} ${-Y[0] / det}"`
  return {
    body:
      `<path class="iso-halo" d="${k.haloOf(bounds, -1, 7, P)}"/>` +
      poses[0].R.items
        .sort((a, b) => a.key - b.key)
        .map((item) =>
          item.name === "issue sheet" ? `<g ${attrs}>${item.svg}</g>` : item.svg
        )
        .join(""),
    parts: poses[0].R.items.length,
    move: "0px 0px",
  }
}
