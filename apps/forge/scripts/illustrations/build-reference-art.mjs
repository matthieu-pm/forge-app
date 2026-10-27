// Geometry-backed revisions following the user's physical-object references.
export function buildReferenceArt(k, G, A, scene) {
  function rig(kind, bounds, top) {
    const P = scene(bounds, top),
      R = A.recorder(P)
    let serial = 0
    const put = (
      paths,
      shape,
      centre,
      tone = "mid",
      lit = false,
      move = [0, 0, 0],
      extra = ""
    ) => {
      const name = `${kind}.${++serial}`
      shape.name = name
      R.solid(shape)
      R.put({
        name,
        at: centre,
        piece: move.some(Boolean) ? "slide" : "body",
        move,
        shapes: [shape],
        svg: k.solidSvg(paths, { tone, lit, crease: "faint", inner: extra }),
      })
      return shape
    }
    const slab = (
      x,
      y,
      w,
      d,
      z,
      h,
      tone = "mid",
      lit = false,
      move = [0, 0, 0],
      r = 1,
      extra = ""
    ) => {
      const plan = { x, y, w, d, r: Math.min(r, w / 3, d / 3) }
      return put(
        k.slabOf(plan, z, h, P, 4, Math.min(0.5, h / 3)),
        A.slab(plan, z, h, {}, 4),
        [x + w / 2, y + d / 2, z + h / 2],
        tone,
        lit,
        move,
        extra
      )
    }
    const turned = (F, s0, s1, r, tone = "mid", lit = false, extra = "") =>
      put(
        G.solidOf(
          [
            [s0, r],
            [s1, r],
          ],
          F,
          P,
          { smooth: true }
        ),
        A.disc(F, s0, s1, r),
        G.add3(F.o, G.mul3(F.a, (s0 + s1) / 2)),
        tone,
        lit,
        [0, 0, 0],
        extra
      )
    const ring = (F, s0, s1, rin, rout, tone = "mid") =>
      put(
        G.ringBand(s0, s1, rin, rout, F, P),
        A.ring(F, s0, s1, rin, rout),
        G.add3(F.o, G.mul3(F.a, (s0 + s1) / 2)),
        tone
      )
    const prism = (
      F,
      poly,
      s0,
      s1,
      tone = "mid",
      concave = false,
      smoothArch = false
    ) => {
      const paths = G.prismOf(F, poly, s0, s1, P)
      if (concave) {
        const at = (s, [x, y]) =>
          G.add3(
            F.o,
            G.add3(G.mul3(F.a, s), G.add3(G.mul3(F.u, x), G.mul3(F.v, y)))
          )
        const low = poly.map((p) => k.iso(at(s0, p), P)),
          high = poly.map((p) => k.iso(at(s1, p), P))
        const closed = (pts) => {
          const area = pts.reduce(
            (sum, p, i) =>
              sum +
              p[0] * pts[(i + 1) % pts.length][1] -
              pts[(i + 1) % pts.length][0] * p[1],
            0
          )
          return k.pathOf(area < 0 ? pts.slice().reverse() : pts, true)
        }
        paths.fill = [
          closed(low),
          closed(high),
          ...low.map((p, i) =>
            closed([
              p,
              low[(i + 1) % poly.length],
              high[(i + 1) % poly.length],
              high[i],
            ])
          ),
        ].join("")
        // The hull outline would bridge the C-shaped opening; use its true caps.
        paths.outline = k.pathOf(low, true) + k.pathOf(high, true)
      }
      let surface = ""
      if (smoothArch) {
        const at = (s, p) =>
          G.add3(
            F.o,
            G.add3(G.mul3(F.a, s), G.add3(G.mul3(F.u, p[0]), G.mul3(F.v, p[1])))
          )
        const V = G.viewOf(P),
          light = G.lightOf(P)
        for (let i = 2; i < poly.length - 1; i++) {
          const a = poly[i],
            b = poly[i + 1]
          const normal = G.unit3(
            G.add3(G.mul3(F.u, b[1] - a[1]), G.mul3(F.v, -(b[0] - a[0])))
          )
          if (G.dot3(normal, V) <= 0) continue
          const t = Math.max(0, Math.min(1, G.dot3(normal, light)))
          const d = k.pathOf(
            [at(s0, a), at(s0, b), at(s1, b), at(s1, a)].map((p) =>
              k.iso(p, P)
            ),
            true
          )
          surface += `<path d="${d}" style="fill:color-mix(in oklab,var(--art-shade-0) ${(100 * (1 - t)).toFixed(2)}%,var(--art-top));stroke:none"/>`
        }
      }
      const mid = poly.reduce(
        (a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length],
        [0, 0]
      )
      return put(
        paths,
        A.prism(F, poly, s0, s1),
        G.add3(
          F.o,
          G.add3(
            G.mul3(F.a, (s0 + s1) / 2),
            G.add3(G.mul3(F.u, mid[0]), G.mul3(F.v, mid[1]))
          )
        ),
        tone,
        false,
        [0, 0, 0],
        surface
      )
    }
    const rules = (x, y, z, w, n = 2) =>
      k.lineSvg(
        Array.from({ length: n }, (_, i) =>
          k.lineOnTop([x, y + i * 3], [x + w - i * 2, y + i * 3], z, P)
        ).join(""),
        { tone: "lo", free: true }
      )
    const finish = (move = [0, 0, 0], ground) => {
      const states = [
        0,
        1,
        ...Array.from({ length: 61 }, (_, i) => ({
          label: `motion ${i}/60`,
          shares: { slide: i / 60 },
        })),
      ]
      A.settle(R, P, { states })

      A.auditOrExit(R, P, { ground, frames: states, apart: true })
      const [x, y] = k.iso(move, { ...P, origin: [0, 0] })
      return {
        body: R.items
          .sort((a, b) => a.key - b.key)
          .map((item) =>
            item.move.some(Boolean)
              ? `<g data-part="mechanism">${item.svg}</g>`
              : item.svg
          )
          .join(""),
        parts: R.items.length,
        move: `${x.toFixed(2)}px ${y.toFixed(2)}px`,
      }
    }
    return { P, R, put, slab, turned, ring, prism, rules, finish }
  }
  function microscope() {
    const o = rig("microscope", { x: -42, y: -37, w: 84, d: 91, r: 4 }, 121)
    const { slab, turned, ring, prism, rules } = o
    const vertical = (x, y) => G.frameAlong([x, y, 0], [0, 0, 1])
    const grounds = []
    for (const x of [-28, 20])
      for (const y of [-25, 29]) grounds.push(slab(x, y, 8, 8, -5, 5, "lo"))
    slab(-37, -34, 74, 78, 0, 7, "mid", false, [0, 0, 0], 5)
    slab(-33, -30, 66, 70, 7, 3, "hi", false, [0, 0, 0], 5)
    // True concave C-column: a smooth sampled elbow with an open stage bay.
    const quad = (a, b, c, t) =>
      a.map((v, i) => (1 - t) ** 2 * v + 2 * (1 - t) * t * b[i] + t * t * c[i])
    const poly = [
      [-29, 64],
      [-29, 68],
    ]
    for (let i = 1; i <= 16; i++)
      poly.push(quad([-29, 68], [-29, 99], [12, 99], i / 16))
    poly.push([23, 99], [23, 85])
    for (let i = 1; i <= 16; i++)
      poly.push(quad([23, 85], [-12, 91], [-12, 64], i / 16))
    poly.push([-12, 64])
    slab(-10, -29, 20, 17, 10, 54, "hi", false, [0, 0, 0], 0)
    prism(
      G.frameOf([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]),
      poly,
      -10,
      10,
      "hi",
      true
    )
    // Focus axes land on the broad planar sides of the column.
    for (const side of [-1, 1]) {
      const F = G.frameAlong([side * 10, -21, 39], [side, 0, 0])
      turned(F, 0, 2, 7, "mid")
      turned(F, 2, 3, 9, "hi")
      turned(F, 3, 3.5, 9.15, "lo")
      turned(F, 3.5, 6, 9, "hi")
      turned(F, 6, 8, 5, "lo")
      turned(F, 8, 10, 4, "hi")
    }
    // Mechanical stage meets the front face of the column at y=-12.
    slab(-30, -12, 60, 47, 42, 3, "mid")
    slab(-27, -9, 54, 41, 45, 0.5, "lo")
    for (const y of [-5, 28]) slab(-25, y, 50, 2, 45.5, 2, "mid")
    for (const x of [-27, 25]) slab(x, -5, 2, 35, 45.5, 3, "hi")
    const move = [3, 0, 0]
    slab(-20, -5, 40, 35, 47.5, 0.7, "hi", true, move, 1)
    slab(-6, 7, 12, 12, 48.2, 0.3, "lo", false, move, 1)
    for (const x of [-18, 14]) slab(x, 0, 3, 26, 48.2, 0.8, "mid", false, move)
    // Lamp, condenser and aperture sit concentrically below the stage.
    turned(vertical(0, 12), 10, 17, 12, "mid")
    turned(vertical(0, 12), 17, 19, 10, "hi")
    turned(vertical(0, 12), 19, 20, 7, "lo")
    turned(vertical(0, 12), 34, 42, 8, "mid")
    ring(vertical(0, 12), 32, 34, 3, 10, "hi")
    // Nosepiece and three objective lenses, each on its own turret seat.
    turned(vertical(0, 22), 81, 85, 10, "mid")
    turned(vertical(0, 22), 78, 81, 12, "hi")
    for (const [x, y, len] of [
      [-6, 22, 13],
      [6, 22, 10],
      [0, 29, 16],
    ]) {
      turned(vertical(x, y), 76, 78, 4, "lo")
      turned(vertical(x, y), 78 - len, 76, 3, "hi")
      turned(vertical(x, y), 77 - len, 78 - len, 3.5, "mid")
      turned(vertical(x, y), 76.5 - len, 77 - len, 2, "lo")
    }
    // Binocular head and two diagonal eyepiece tubes.
    prism(
      G.frameOf([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]),
      [
        [16, 99],
        [30, 99],
        [30, 101.01],
        [16, 112.99],
      ],
      -14,
      14,
      "mid"
    )
    for (const x of [-7, 7]) {
      const F = G.frameAlong([x, 23, 107], [0, 0.65, 0.76])
      turned(F, 0, 10, 5, "mid")
      turned(F, 10, 13, 6, "hi")
      turned(F, 13, 16, 5.5, "hi")
      turned(F, 16, 16.4, 4.1, "lo")
    }
    slab(
      17,
      31,
      12,
      6,
      10,
      0.3,
      "lo",
      false,
      [0, 0, 0],
      1,
      rules(19, 33, 10.4, 7, 1)
    )
    return o.finish(move, (s) => grounds.includes(s))
  }
  function satellite() {
    const o = rig("satellite", { x: -99, y: -43, w: 198, d: 88, r: 0 }, 67)
    const { P, put, slab, turned, ring } = o
    const F = G.frameAlong([0, 0, 36], [0, 1, 0])
    // The central barrel is the physical root of this free-flying object.
    let host
    let prior = -25
    for (const edge of [-21, -7, 8, 20, 23]) {
      const segment = turned(F, prior, edge, 18, "mid")
      if (prior < 0 && edge > 0) host = segment
      if (edge < 23) turned(F, edge, edge + 0.7, 18.5, "hi")
      prior = edge + 0.7
    }
    for (const [a, b, r] of [
      [-29, -25, 17],
      [-31, -29, 12],
      [23, 26, 18.8],
      [26, 29, 15],
      [29, 31, 12],
    ])
      turned(F, a, b, r, "hi")
    turned(F, 31, 31.5, 9, "lo")
    for (const side of [-1, 1]) {
      const frame = G.frameAlong([0, 0, 36], [side, 0, 0])
      const start = (angle) => Math.sqrt(18 ** 2 - (4 * Math.sin(angle)) ** 2)
      put(
        G.saddleOf(frame, 4, start, 20, P),
        A.disc(frame, 17.5, 20, 4, { cut: host, seated: true }),
        [side * 19, 0, 36],
        "mid"
      )
      // Small rectangular boom touches the saddle's flat outer face.
      const polygon = [
        [-1.5, -1.5],
        [1.5, -1.5],
        [1.5, 1.5],
        [-1.5, 1.5],
      ]
      o.prism(frame, polygon, 20, 28, "hi")
      for (let panel = 0; panel < 3; panel++) {
        const x = side < 0 ? -96 + panel * 23 : 28 + panel * 23
        slab(x, -20, 22, 40, 34.5, 3, "mid")
        // Six solar cells per segment, with a shallow perimeter rebate.
        for (let row = 0; row < 3; row++)
          for (let col = 0; col < 2; col++)
            slab(x + 2 + col * 10, -18 + row * 12, 8, 10, 37.5, 0.4, "lo")
        if (panel < 2) {
          const hingeX = x + 22
          slab(hingeX, -13, 1, 5, 35.5, 1, "hi")
          slab(hingeX, 8, 1, 5, 35.5, 1, "hi")
        }
      }
    }
    // Tangential top instrument plate and a short rigid antenna mast.
    const top = G.frameAlong([0, 0, 36], [0, 0, 1])
    const start = (angle) => Math.sqrt(18 ** 2 - (5 * Math.cos(angle)) ** 2)
    put(
      G.saddleOf(top, 5, start, 20, P),
      A.disc(top, 17, 20, 5, { cut: host, seated: true }),
      [0, 0, 55],
      "mid"
    )
    turned(top, 20, 22, 4, "hi")
    turned(top, 22, 29, 1, "hi")
    turned(top, 29, 30, 2, "mid")
    // Static round hardware; a small scan tab advances along the solar bus.
    for (const side of [-1, 1]) {
      const F2 = G.frameAlong([side * 18, 15, 36], [side, 0, 0])
      turned(F2, 0, 1, 2, "mid")
    }
    const move = [0, 3, 0]
    slab(33, -17, 5, 8, 37.9, 0.3, "hi", true, move, 0)
    return o.finish(move, (s) => s === host)
  }
  function mailbox() {
    const o = rig("mailbox", { x: -40, y: -48, w: 80, d: 92, r: 2 }, 116)
    const { slab, prism, turned, rules, P } = o
    const grounds = []
    for (const x of [-24, 17])
      for (const y of [-37, 22]) grounds.push(slab(x, y, 7, 7, -5, 5, "lo"))
    slab(-32, -45, 64, 80, 0, 5, "lo", false, [0, 0, 0], 4)
    slab(-10, -43, 20, 18, 5, 4, "mid")
    slab(-7, -41, 14, 13, 9, 99, "mid")
    slab(-9, -43, 18, 17, 108, 3, "hi")
    slab(-7, -41, 14, 13, 111, 2, "mid")
    slab(-3, -37, 6, 5, 113, 3, "hi")
    slab(-8, -28, 16, 59, 50, 5, "mid")
    prism(
      G.frameOf([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]),
      [
        [-28, 21],
        [-28, 50],
        [21, 50],
      ],
      -3,
      3,
      "lo"
    )
    const frame = G.frameOf([0, 0, 0], [0, 1, 0], [1, 0, 0], [0, 0, 1])
    const arch = (r = 25) => [
      [-r, 55],
      [r, 55],
      [r, 78],
      ...Array.from({ length: 129 }, (_, i) => [
        r * Math.cos((i * Math.PI) / 128),
        78 + r * Math.sin((i * Math.PI) / 128),
      ]),
    ]
    let start = -28
    for (const end of [-18, 0, 18, 30]) {
      prism(frame, arch(), start, end, "mid", false, true)
      if (end < 30) prism(frame, arch(25.4), end, end + 0.8, "hi", false, true)
      start = end + 0.8
    }
    // Closed front door has a true arched perimeter, inset engraving and plaque.
    prism(frame, arch(24), 30, 31.5, "hi", false, true)
    const front = arch(21).map(([x, z]) => [x, 31.6, z + 2])
    const trim = k.lineSvg(
      k.pathOf(
        front.map((p) => k.iso(p, P)),
        true
      ),
      { tone: "lo" }
    )
    const last = o.R.items[o.R.items.length - 1]
    last.svg += trim
    slab(-14, 31.5, 28, 0.8, 65, 18, "lo")
    slab(-11, 32.3, 22, 0.4, 68, 12, "mid")
    for (let i = 0; i < 3; i++) {
      const d = k.segment(
        [-7, 32.8, 71 + i * 3],
        [7 - (i === 2 ? 4 : 0), 32.8, 71 + i * 3],
        P
      )
      o.R.items[o.R.items.length - 1].svg += k.lineSvg(d, {
        tone: "lo",
        free: true,
      })
    }
    for (const x of [-24, 20]) slab(x, 31.5, 4, 3, 60, 6, "mid")
    slab(-4, 31.5, 8, 4, 88, 3, "hi")
    // A raised flag is fixed to its side pivot; no detached floating animation.
    slab(25, 10, 2, 8, 73, 8, "mid")
    const F = G.frameAlong([27, 14, 77], [1, 0, 0])
    turned(F, 0, 2, 3, "hi")
    slab(29, 13, 1, 2, 77, 25, "hi")
    slab(29, 13, 1, 13, 96, 6, "hi")
    // Case-side identification plate, with its rules on that same plane.
    slab(25, -18, 0.5, 21, 64, 10, "lo")
    for (let i = 0; i < 2; i++)
      o.R.items[o.R.items.length - 1].svg += k.lineSvg(
        k.segment([25.6, -14, 67 + i * 3], [25.6, -3, 67 + i * 3], P),
        { tone: "lo", free: true }
      )
    for (const [x, y] of [
      [-27, -39],
      [27, -39],
      [-27, 30],
      [27, 30],
    ])
      turned(G.frameAlong([x, y, 5], [0, 0, 1]), 0, 0.7, 1.4, "hi")
    for (const x of [-18, 18])
      for (const z of [62, 77, 91])
        turned(G.frameAlong([x, 31.5, z], [0, 1, 0]), 0, 0.5, 0.9, "hi")
    return o.finish([0, 0, 0], (shape) => grounds.includes(shape))
  }
  return { reviews: microscope(), signals: satellite(), inbox: mailbox() }
}
