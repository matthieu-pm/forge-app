/**
 * Calls: a face-up smartphone, built as one assembled physical object.
 * See docs/qa/empty-state-art/concept.md for the parts planned before geometry.
 * Screen marks are thin inlays on the glass; the waveform's ink gently pulses.
 */
export function buildCallSmartphone(k, G, A, scene) {
  const bounds = { x: -28, y: -59, w: 56, d: 118, r: 8 }
  const P = scene(bounds, 8)
  const R = A.recorder(P)
  const line = (d, tone = "lo", free = false) => k.lineSvg(d, { tone, free })
  const onScreen = (points, tone = "mid") =>
    line(k.onTop(points, 7.21, P, true), tone)
  function put(name, paths, shape, at, tone, extra = {}) {
    shape.name = name
    R.solid(shape)
    const svg = k.solidSvg(paths, {
      tone,
      crease: "faint",
      lit: extra.lit,
      inner: extra.inner ?? "",
    })
    R.put({
      name,
      shapes: [shape],
      at,
      piece: "phone",
      move: [0, 0, 0],
      svg: extra.className ? `<g class="${extra.className}">${svg}</g>` : svg,
    })
    return shape
  }
  function slab(name, x, y, w, d, z, h, tone = "mid", extra = {}) {
    const plan = { x, y, w, d, r: Math.min(extra.r ?? 0.7, w / 2, d / 2) }
    return put(
      name,
      k.slabOf(plan, z, h, P, 8, Math.min(extra.bevel ?? 0.5, h / 3)),
      A.slab(plan, z, h, {}, 8),
      [x + w / 2, y + d / 2, z + h / 2],
      tone,
      extra
    )
  }
  // A closed inset on the exposed bottom face, extruded away from the chassis.
  function bottomInset(name, x, z, w, h, extra = {}) {
    const F = { o: [x, 59, z], a: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] }
    const poly = k.roundedPlan({ x: -w / 2, y: -h / 2, w, d: h, r: h / 2 }, 6)
    return put(
      name,
      G.prismOf(F, poly, 0, 0.06, P),
      A.prism(F, poly, 0, 0.06),
      [x, 59.03, z],
      "lo",
      { className: "smartphone-recess", ...extra }
    )
  }

  const ground = slab("rear shell", -28, -59, 56, 118, 0, 1, "lo", { r: 8 })
  slab("metal chassis", -28, -59, 56, 118, 1, 5, "hi", {
    r: 8,
    bevel: 0.8,
    inner: line(k.sideSeam(bounds, 2.3, P, 8), "faint"),
  })
  slab("display bezel", -27.5, -58.5, 55, 117, 6, 0.7, "hi", { r: 7.5 })
  slab("display glass", -25.8, -56.8, 51.6, 113.6, 6.7, 0.3, "mid", {
    r: 6.2,
    className: "smartphone-glass",
    inner: line(
      k.planOutline({ x: -24.6, y: -55.6, w: 49.2, d: 111.2, r: 5.2 }, 7, P, 8),
      "faint"
    ),
  })

  // Side-key seats touch the straight section of the aluminum side wall.
  for (const [index, [y, length]] of [
    [-34, 11],
    [-19, 11],
    [4, 18],
  ].entries()) {
    const seatX = index < 2 ? -28.2 : 28
    const keyX = index < 2 ? -29 : 28.2
    slab(`key seat ${index}`, seatX, y, 0.2, length, 2.5, 2.2, "lo")
    slab(`side key ${index}`, keyX, y + 0.6, 0.8, length - 1.2, 2.9, 1.4, "hi")
  }
  for (const [index, y] of [-44, 43].entries()) {
    slab(`antenna break ${index}`, 28, y, 0.08, 1.2, 1, 5, "lo")
    slab(`antenna cap ${index}`, 25.8, y, 2.2, 1.2, 6, 0.05, "lo")
  }

  slab("earpiece recess", -10, -51, 18, 2.8, 7, 0.1, "lo", {
    r: 1.4,
    className: "smartphone-recess",
  })
  for (let i = 0; i < 8; i++)
    slab(
      `earpiece mesh ${i}`,
      -8.8 + i * 2,
      -50.5,
      0.8,
      1.8,
      7.1,
      0.06,
      "mid",
      { r: 0.4 }
    )
  slab("camera surround", 10.5, -51.4, 4, 4, 7, 0.1, "mid", { r: 2 })
  slab("camera lens", 11.2, -50.7, 2.6, 2.6, 7.1, 0.06, "lo", {
    r: 1.3,
    className: "smartphone-recess",
  })
  slab("lens reflection", 11.7, -50.4, 0.65, 0.65, 7.16, 0.04, "hi", { r: 0.3 })

  bottomInset("USB-C socket", 0, 3.4, 11.5, 2.4)
  bottomInset("connector tongue", 0, 3.4, 7, 0.5, {
    className: "smartphone-ink",
  })
  for (const [index, x] of [-21, -18, -15, 15, 18, 21].entries())
    bottomInset(`speaker aperture ${index}`, x, 3.4, 1.6, 1.6)
  for (const [index, x] of [-9, 9].entries())
    bottomInset(`retaining screw ${index}`, x, 3.4, 1, 1)

  // A quiet call screen. All inlays lie within the glass's rounded boundary.
  const ink = { className: "smartphone-ink", r: 0.5 }
  slab("status clock", -19, -42, 7, 1.3, 7, 0.1, "mid", ink)
  slab("battery indicator", 13, -42, 6, 2, 7, 0.1, "mid", ink)
  slab("caller disc", -8, -30, 16, 16, 7, 0.1, "mid", { r: 8 })
  slab("caller head", -2.4, -26.7, 4.8, 4.8, 7.1, 0.06, "hi", {
    ...ink,
    r: 2.4,
  })
  slab("caller shoulders", -4.8, -20.7, 9.6, 3.7, 7.1, 0.06, "hi", {
    ...ink,
    r: 1.8,
  })
  for (const [index, [w, y]] of [
    [20, -9],
    [12, -5],
  ].entries())
    slab(`caller name ${index}`, -w / 2, y, w, 1.1, 7, 0.1, "mid", ink)
  const waveformNames = new Set()
  for (const [index, h] of [3, 5, 8, 4, 11, 15, 9, 5, 8, 5, 3].entries()) {
    const name = `waveform bar ${index}`
    waveformNames.add(name)
    slab(name, -16 + index * 3, 11 - h / 2, 1.2, h, 7, 0.1, "hi", ink)
  }
  const controlGlyphs = [
    // Microphone capsule and a closed U-shaped mount.
    onScreen([
      [-15.2, 29],
      [-12.8, 29],
      [-12.8, 33.5],
      [-15.2, 33.5],
    ]) +
      onScreen([
        [-17, 32],
        [-16, 32],
        [-16, 35],
        [-12, 35],
        [-12, 32],
        [-11, 32],
        [-11, 36],
        [-13.5, 36],
        [-13.5, 38],
        [-14.5, 38],
        [-14.5, 36],
        [-17, 36],
      ]),
    // Handset, the single emphasized element in the figure.
    onScreen(
      [
        [-5, 32],
        [-3.5, 30.5],
        [3.5, 30.5],
        [5, 32],
        [5, 34.5],
        [2.8, 34.5],
        [1.8, 33],
        [-1.8, 33],
        [-2.8, 34.5],
        [-5, 34.5],
      ],
      "hi"
    ),
    // Speaker cone and its attached grille.
    onScreen([
      [10, 31.5],
      [12.5, 31.5],
      [16, 29],
      [16, 37],
      [12.5, 34.5],
      [10, 34.5],
    ]) +
      onScreen([
        [18, 31],
        [19, 31],
        [19, 35],
        [18, 35],
      ]),
  ]
  for (const [index, x] of [-14, 0, 14].entries())
    slab(`call control ${index}`, x - 5.8, 27.2, 11.6, 11.6, 7, 0.2, "mid", {
      r: 5.8,
      lit: index === 1,
      inner: controlGlyphs[index],
    })
  slab("home indicator", -8, 49, 16, 1.3, 7, 0.1, "mid", ink)

  // Resolve the thin screen inlays and mesh more finely than metalwork parts.
  A.settle(R, P, { states: [0], step: 0.1, tolerance: 0.01, least: 0.02 })
  A.auditOrExit(R, P, { ground: (shape) => shape === ground, frames: [0] })
  return {
    body:
      `<path class="iso-halo" d="${k.haloOf(bounds, -0.5, 7, P)}"/>` +
      R.items
        .sort((a, b) => a.key - b.key)
        .map((item) =>
          waveformNames.has(item.name)
            ? `<g data-motion="call-waveform">${item.svg}</g>`
            : item.svg
        )
        .join(""),
    parts: R.items.length,
    move: "0px 0px",
  }
}
