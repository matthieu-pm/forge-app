/**
 * Milestone: a checkpoint station waiting for its first work ticket.
 * The diamond is the checkpoint; the empty intake tray is its unassigned work.
 * A registration gate lifts four units on hover/focus, staying in its guides.
 *
 * Parts planned before geometry (58 solids, all attached):
 * Base: 4 rubber pads, 4 feet, plinth, cover, 4 corner fasteners (14).
 * Structure: 2 shoe plates, 2 shoes, 2 posts, 2 post caps, 3 cross braces,
 *   4 shoe bolts (15; cumulative 29).
 * Marker: diamond backing, 4 frame rails, inset diamond, 4 mounting rivets
 *   (10; cumulative 39).
 * Intake: tray floor, 2 side lips, front stop, 2 guide shoes, 2 guide posts,
 *   2 end caps, 2 slider bushings, registration bar (13; cumulative 52).
 * Finish: 2 tray clips, 2 clip pads, front label plate, serial inset (6; 58).
 * Screws, folded seams and engraved rules belong to those surfaces.
 */
export function buildMilestoneArt(k, G, A, scene) {
  const bounds = { x: -48, y: -35, w: 96, d: 83, r: 3 }
  const P = scene(bounds, 91)
  const R = A.recorder(P)
  const ground = []
  const move = [0, 0, 4]
  const line = (d, tone = "lo", free = false) => k.lineSvg(d, { tone, free })
  const dots = (points) =>
    k.dotsSvg(
      points.map((p) => k.iso(p, P)),
      { size: 0.45, tone: "mid" }
    )
  function put(
    name,
    paths,
    shape,
    at,
    tone = "mid",
    lit = false,
    moving = false,
    inner = ""
  ) {
    shape.name = name
    R.solid(shape)
    R.put({
      name,
      shapes: [shape],
      at,
      piece: moving ? "gate" : "body",
      move: moving ? move : [0, 0, 0],
      svg: k.solidSvg(paths, { tone, lit, crease: "faint", inner }),
    })
    return shape
  }
  function slab(name, x, y, w, d, z, h, tone = "mid", extra = {}) {
    const plan = { x, y, w, d, r: Math.min(extra.r ?? 0.7, w / 4, d / 4) }
    return put(
      name,
      k.slabOf(plan, z, h, P, 4, Math.min(0.6, h / 3)),
      A.slab(plan, z, h, {}, 4),
      [x + w / 2, y + d / 2, z + h / 2],
      tone,
      extra.lit,
      extra.moving,
      (extra.inner ?? "") +
        (extra.seam ? line(k.sideSeam(plan, z + h / 2, P, 4), "faint") : "")
    )
  }
  const face = { o: [0, -18, 63], a: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] }
  function prism(name, poly, from, to, tone = "mid", lit = false, inner = "") {
    const mid = poly.reduce(
      (p, q) => [p[0] + q[0] / poly.length, p[1] + q[1] / poly.length],
      [0, 0]
    )
    return put(
      name,
      G.prismOf(face, poly, from, to, P),
      A.prism(face, poly, from, to),
      [mid[0], -18 + (from + to) / 2, 63 + mid[1]],
      tone,
      lit,
      false,
      inner
    )
  }
  const diamond = (w, h) => [
    [0, -h],
    [w, 0],
    [0, h],
    [-w, 0],
  ]
  // A low, heavy plinth: four isolated pad/foot stacks meet its underside.
  for (const [i, [x, y]] of k.corners(bounds, 10).entries()) {
    ground.push(slab(`rubber pad ${i}`, x - 4, y - 4, 8, 8, -9, 2, "lo"))
    slab(`foot ${i}`, x - 3, y - 3, 6, 6, -7, 3, "lo")
  }
  slab("plinth", -48, -35, 96, 83, -4, 5, "lo", { r: 3, seam: true })
  slab("cover", -44, -31, 88, 75, 1, 3, "mid", {
    r: 2,
    inner: line(
      k.planOutline({ x: -41, y: -28, w: 82, d: 69, r: 1.5 }, 4, P, 4),
      "faint"
    ),
  })
  for (const [i, [x, y]] of k.corners(bounds, 8).entries())
    slab(`cover fastener ${i}`, x - 1, y - 1, 2, 2, 4, 0.5, "mid", {
      inner: dots([[x, y, 4.5]]),
    })
  // Paired stanchions hold the diamond from its rear face.
  for (const [i, x] of [-18, 14].entries()) {
    slab(`shoe plate ${i}`, x - 3, -28, 10, 14, 4, 1.5, "lo")
    slab(`shoe ${i}`, x - 1, -25, 6, 9, 5.5, 3.5, "mid")
    slab(`post ${i}`, x, -23, 4, 5, 9, 61, "mid", { seam: true })
    slab(`post cap ${i}`, x - 0.6, -24, 5.2, 6, 70, 1.5, "hi")
    for (const [j, y] of [-26, -16].entries())
      slab(`shoe bolt ${i}.${j}`, x + 0.7, y, 2.6, 1.4, 5.5, 0.6, "mid")
  }
  for (const [i, z] of [18, 39, 60].entries())
    slab(`cross brace ${i}`, -18, -26, 36, 3, z, 3, "lo")
  prism("diamond backing", diamond(25, 28), 0, 3, "mid")
  const outer = diamond(24, 27),
    inner = diamond(20, 22.5)
  for (let i = 0; i < 4; i++)
    prism(
      `diamond frame ${i}`,
      [outer[i], outer[(i + 1) % 4], inner[(i + 1) % 4], inner[i]],
      3,
      5,
      "hi"
    )
  prism("checkpoint face", diamond(17, 19), 3, 3.7, "hi", true)
  for (const [i, [x, z]] of [
    [0, -24],
    [21, 0],
    [0, 24],
    [-21, 0],
  ].entries())
    prism(
      `marker rivet ${i}`,
      [
        [x - 0.7, z - 0.7],
        [x + 0.7, z - 0.7],
        [x + 0.7, z + 0.7],
        [x - 0.7, z + 0.7],
      ],
      5,
      5.45,
      "mid"
    )
  // The empty ticket tray sits in front of the marker, with folded edges.
  slab("tray floor", -28, 5, 56, 32, 4, 1.5, "mid", {
    inner: line(
      k.planOutline({ x: -25, y: 8, w: 50, d: 26, r: 1 }, 5.5, P, 4),
      "faint"
    ),
  })
  for (const [i, x] of [-30, 28].entries())
    slab(`tray lip ${i}`, x, 5, 2, 34, 4, 4, "mid")
  slab("front stop", -28, 37, 56, 2, 4, 4, "hi")
  for (const [i, x] of [-34, 30].entries()) {
    slab(`guide shoe ${i}`, x - 1, -5, 6, 10, 4, 2, "lo")
    slab(`guide post ${i}`, x, -2, 4, 6, 6, 20, "mid")
    slab(`guide cap ${i}`, x - 0.4, -2.4, 4.8, 6.8, 26, 1, "hi")
    slab(`slider bushing ${i}`, i === 0 ? -30 : 27, -1, 3, 4, 12, 5, "hi", {
      moving: true,
    })
  }
  slab("registration gate", -27, -1, 54, 4, 13, 3, "hi", {
    moving: true,
    inner: line(k.lineOnTop([-27, 1], [27, 1], 16, P), "faint"),
  })
  for (const [i, x] of [-20, 15].entries()) {
    slab(`clip pad ${i}`, x, 31, 5, 5, 5.5, 0.6, "lo")
    slab(`tray clip ${i}`, x + 1, 31, 3, 5, 6.1, 1, "mid")
  }
  slab("label plate", -19, 44, 38, 0.7, 1, 2.5, "lo", {
    inner:
      line(k.segment([-16, 44.75, 2.4], [7, 44.75, 2.4], P), "lo", true) +
      dots([
        [-17, 44.75, 2],
        [17, 44.75, 2],
      ]),
  })
  slab("serial inset", 10, 44.7, 5, 0.2, 1.7, 1, "mid")

  const states = [
    0,
    1,
    ...Array.from({ length: 21 }, (_, i) => ({
      label: `gate ${i}/20`,
      shares: { gate: i / 20 },
    })),
  ]
  A.settle(R, P, { states })
  A.auditOrExit(R, P, {
    ground: (shape) => ground.includes(shape),
    frames: states,
    apart: true,
  })
  const [dx, dy] = k.iso(move, { ...P, origin: [0, 0] })
  return {
    body:
      `<path class="iso-halo" d="${k.haloOf(bounds, -9, 6, P)}"/>` +
      R.items
        .sort((a, b) => a.key - b.key)
        .map((item) =>
          item.move.some(Boolean)
            ? `<g data-part="checkpoint-gate">${item.svg}</g>`
            : item.svg
        )
        .join(""),
    parts: R.items.length,
    move: `${dx.toFixed(2)}px ${dy.toFixed(2)}px`,
  }
}
