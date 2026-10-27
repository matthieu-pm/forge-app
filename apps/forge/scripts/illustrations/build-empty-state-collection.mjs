// Flat-faced physical objects for Forge's decorative empty states.
export function buildCollection(k, G, drawing, scene) {
  function object(bounds, top) {
    const P = scene(bounds, top)
    const d = drawing(P)
    const { parts, box, S, L, dots } = d
    const add = (...items) => parts.push(...items)
    const loop = (points, tone = "lo") =>
      L(
        k.pathOf(
          points.map((p) => k.iso(p, P)),
          true
        ),
        tone
      )
    const beam = (a, b, w, h, tone = "mid", lit = false) => {
      const axis = b.map((v, i) => v - a[i])
      const F = G.frameAlong(a, axis)
      return d.solid(
        G.prismOf(
          F,
          [
            [-w / 2, -h / 2],
            [w / 2, -h / 2],
            [w / 2, h / 2],
            [-w / 2, h / 2],
          ],
          0,
          Math.hypot(...axis),
          P
        ),
        tone,
        lit
      )
    }
    const rules = (x, y, z, w, n = 3) =>
      L(
        Array.from({ length: n }, (_, i) =>
          k.lineOnTop(
            [x, y + i * 3],
            [x + w - (i === n - 1 ? w * 0.3 : 0), y + i * 3],
            z,
            P
          )
        ).join(""),
        "lo",
        true
      )
    const screws = (x, y, w, depth, z) =>
      dots(k.corners({ x, y, w, d: depth, r: 0 }, 3).map(([a, b]) => [a, b, z]))
    const slot = (x, y, w, depth, z, tone = "lo") =>
      loop(
        [
          [x, y, z],
          [x + w, y, z],
          [x + w, y + depth, z],
          [x, y + depth, z],
        ],
        tone
      )
    const moving = (items, vector) => {
      add(`<g data-part="mechanism">${items.join("")}</g>`)
      d.vector = vector
    }
    const finish = () => {
      const [x, y] = k.iso(d.vector ?? [0, 0, 0], { ...P, origin: [0, 0] })
      return {
        body: parts.join(""),
        parts: d.count(),
        move: `${x.toFixed(2)}px ${y.toFixed(2)}px`,
      }
    }
    return { ...d, P, add, loop, beam, rules, screws, slot, moving, finish }
  }

  function issues() {
    const o = object({ x: -48, y: -36, w: 96, d: 99, r: 3 }, 79)
    const { add, box, beam, rules, screws, slot, moving, base, finish } = o
    base({ x: -46, y: -34, w: 92, d: 88, r: 4 })
    add(box(-41, -29, 82, 74, 1, 7, "mid"), box(-32, -23, 64, 62, 8, 0.5, "lo"))
    for (const x of [-37, 33]) {
      add(box(x, -25, 4, 65, 8, 3, "mid"))
      for (const y of [-28, 39]) add(box(x - 1, y, 6, 3, 8, 5, "hi"))
    }
    for (const x of [-31, 23]) {
      add(box(x, -23, 8, 16, 8, 5, "mid"), box(x + 1, -22, 6, 14, 13, 45, "hi"))
      add(box(x - 1, -24, 10, 18, 58, 6, "mid"))
    }
    add(box(-33, -26, 66, 22, 64, 7, "hi"), screws(-33, -26, 66, 22, 71.2))
    add(box(-12, -21, 2, 12, 49, 9, "lo"), box(10, -21, 2, 12, 49, 9, "lo"))
    add(
      box(-10, -21, 20, 12, 42, 22, "mid"),
      box(-17, -25, 34, 21, 38, 4, "hi"),
      box(-15, -23, 30, 17, 36, 2, "lo")
    )
    // Lever rises above the crosshead, with a grip on its outer end.
    add(
      box(-4, -20, 8, 10, 71, 3, "mid"),
      beam([0, -15, 74], [24, -15, 79], 3, 3, "mid"),
      box(22, -20, 12, 10, 77, 4, "hi")
    )
    const ticket = [
      box(-27, 2, 54, 43, 9, 0.6, "hi", true),
      box(-24, 5, 48, 6, 9.6, 0.3, "mid"),
    ]
    for (let i = 0; i < 3; i++)
      ticket.push(
        slot(-22, 16 + i * 8, 4, 4, 9.8),
        box(-21, 17 + i * 8, 2, 2, 9.7, 0.2, "lo"),
        rules(-13, 17 + i * 8, 9.8, 29, 1)
      )
    moving(ticket, [0, 5, 0])
    add(
      box(-32, 47, 64, 5, 8, 2, "hi"),
      box(31, 17, 6, 11, 11, 1, "mid"),
      box(31, 31, 6, 8, 11, 1, "hi")
    )
    add(
      box(-19, 48, 19, 3, 10, 0.3, "lo"),
      rules(-17, 49, 10.4, 14, 1),
      screws(-41, -29, 82, 74, 8.6)
    )
    return finish()
  }

  function initiatives() {
    const o = object({ x: -59, y: -43, w: 118, d: 88, r: 4 }, 26)
    const { add, box, S, beam, rules, screws, moving, base, finish } = o
    base({ x: -58, y: -42, w: 116, d: 86, r: 4 })
    add(
      S({ x: -54, y: -38, w: 108, d: 78, r: 3 }, 1, 9, "mid"),
      box(-48, -32, 96, 57, 10, 0.7, "lo")
    )
    for (const y of [-35, 26]) add(box(-50, y, 100, 2, 10, 3, "hi"))
    for (const x of [-51, 49]) add(box(x, -35, 2, 63, 10, 3, "mid"))
    const route = [
      [-37, -21],
      [-15, -21],
      [-15, 9],
      [9, 9],
      [9, -15],
      [34, -15],
    ]
    for (let i = 0; i < route.length - 1; i++)
      add(beam([...route[i], 11], [...route[i + 1], 11], 1, 1, "mid"))
    route.forEach(([x, y], i) => {
      add(
        box(x - 4, y - 4, 8, 8, 10.7, 2, "mid"),
        box(x - 2.5, y - 2.5, 5, 5, 12.7, i === 5 ? 5 : 2, "hi", i === 5)
      )
    })
    // The route pointer and two narrow runners sit above the map.
    for (const y of [-27, -16]) add(box(-42, y, 32, 1, 13, 1, "lo"))
    moving(
      [box(-39, -26, 7, 10, 14, 1, "hi"), box(-37, -24, 3, 6, 15, 1, "mid")],
      [12, 0, 0]
    )
    for (let i = 0; i < 3; i++) {
      add(
        box(20 + i * 2, 4 + i * 3, 23, 16, 11 + i * 0.6, 0.6, "mid"),
        box(22 + i * 2, 2 + i * 3, 8, 2, 11 + i * 0.6, 0.6, "lo")
      )
      add(rules(24 + i * 2, 8 + i * 3, 11.7 + i * 0.6, 13, 2))
    }
    for (const x of [-35, 4]) {
      add(box(x, 31, 28, 5, 10, 1, "lo"))
      for (const y of [31, 35]) add(box(x, y, 28, 0.7, 11, 0.6, "mid"))
      add(box(x + 9, 31.7, 5, 3.3, 11, 2, "hi"))
    }
    add(
      box(36, 31, 10, 5, 10, 0.5, "lo"),
      rules(38, 33, 10.6, 6, 1),
      screws(-54, -38, 108, 78, 10.2)
    )
    return finish()
  }

  function triage() {
    const o = object({ x: -58, y: -45, w: 116, d: 102, r: 3 }, 39)
    const { add, box, rules, screws, moving, base, finish } = o
    base({ x: -56, y: -43, w: 112, d: 96, r: 4 })
    add(box(-52, -39, 104, 87, 1, 6, "mid"))
    // Three receiving lanes, built rear-first to keep their open mouths clear.
    for (let col = 0; col < 3; col++) {
      const x = -46 + col * 31
      add(box(x, -33, 27, 39, 7, 2, "lo"), box(x, -35, 27, 2, 9, 12, "mid"))
      add(box(x + 3, -28, 21, 26, 9, 0.7, "mid"), rules(x + 7, -22, 9.8, 13, 3))
      add(box(x + 5, -33, 17, 3, 21, 0.4, "hi"), rules(x + 8, -32, 21.5, 11, 1))
    }
    for (const x of [-49, -18, 13, 44]) add(box(x, -35, 3, 43, 7, 14, "mid"))
    add(box(-47, 9, 94, 32, 7, 0.6, "lo"))
    for (const x of [-49, 45]) {
      add(box(x, 8, 3, 36, 7, 3, "mid"))
      for (const y of [7, 43]) add(box(x - 1, y, 5, 2, 7, 5, "hi"))
    }
    for (let i = 0; i < 3; i++) {
      const x = -46 + i * 31
      add(box(x + 2, 1, 4, 5, 9, 20, "mid"), box(x + 6, 1, 17, 5, 25, 4, "hi"))
      for (const j of [0, 1]) add(box(x + 4 + j * 16, 1, 3, 5, 23, 2, "lo"))
    }
    const ticket = [
      box(-12, 18, 24, 24, 7.7, 0.7, "hi", true),
      box(-9, 21, 18, 4, 8.4, 0.3, "mid"),
      rules(-7, 29, 8.5, 14, 3),
    ]
    moving(ticket, [0, -5, 0])
    add(box(-20, 44, 40, 7, 7, 3, "hi"))
    for (let i = 0; i < 3; i++) add(box(-15 + i * 11, 45, 7, 4, 10, 0.8, "mid"))
    add(screws(-52, -39, 104, 87, 7.2))
    return finish()
  }

  function cycles() {
    const o = object({ x: -52, y: -40, w: 104, d: 86, r: 3 }, 29)
    const { add, box, S, rules, screws, moving, base, finish } = o
    base({ x: -50, y: -38, w: 100, d: 80, r: 4 })
    add(
      S({ x: -46, y: -34, w: 92, d: 71, r: 3 }, 1, 8, "mid"),
      box(-42, -29, 84, 59, 9, 1, "hi")
    )
    add(box(-42, -29, 84, 9, 10, 0.5, "mid"))
    for (let col = 0; col < 7; col++) {
      const x = -38 + col * 11
      add(box(x, -26, 8, 4, 10.5, 0.3, "lo"))
      for (let row = 0; row < 3; row++) {
        add(box(x, -15 + row * 12, 8, 9, 10, 0.5, "mid"))
        add(rules(x + 2, -11 + row * 12, 10.6, 4, 1))
      }
    }
    // Seven squared binding loops connect the header to the rear support.
    add(box(-44, -34, 88, 4, 9, 7, "mid"))
    for (let i = 0; i < 7; i++) {
      const x = -36 + i * 11
      add(
        box(x, -33, 2, 2, 16, 5, "hi"),
        box(x, -23, 2, 2, 10.5, 10.5, "hi"),
        box(x, -31, 2, 8, 19, 2, "hi")
      )
    }
    for (const y of [-17, -5]) add(box(-40, y, 79, 1, 10.5, 1, "lo"))
    for (const x of [-42, 39]) add(box(x, -18, 2, 15, 10.5, 3, "mid"))
    const cursor = []
    for (const y of [-17, -5])
      cursor.push(box(-39, y, 10, 1, 11.5, 1, "hi", true))
    for (const x of [-39, -30])
      cursor.push(box(x, -16, 1, 11, 11.5, 1, "hi", true))
    cursor.push(box(-36, -19, 4, 2, 11.5, 2, "mid"))
    moving(cursor, [11, 0, 0])
    add(
      box(-12, 32, 24, 3, 9, 0.5, "lo"),
      rules(-9, 33, 9.6, 18, 1),
      screws(-46, -34, 92, 71, 9.2)
    )
    return finish()
  }

  function documents() {
    const o = object({ x: -49, y: -39, w: 98, d: 87, r: 3 }, 74)
    const { add, box, rules, screws, moving, base, finish } = o
    base({ x: -47, y: -37, w: 94, d: 82, r: 4 })
    add(box(-42, -32, 84, 71, 1, 5, "mid"))
    for (const x of [-34, 28]) {
      add(box(x, -26, 6, 51, 6, 4, "lo"))
      for (const y of [-25, 18]) add(box(x, y, 6, 7, 10, 49, "mid"))
    }
    const head =
      box(-36, -28, 72, 55, 59, 5, "hi") + screws(-36, -28, 72, 55, 64.1)
    for (let i = 0; i < 8; i++)
      add(box(-25, -20, 50, 48, 6 + i * 0.65, 0.55, "mid"))
    add(
      box(-27, -22, 54, 52, 11.2, 2, "hi"),
      box(-28, -23, 56, 54, 5.5, 0.5, "lo")
    )
    for (const x of [-29, 27])
      for (const y of [-25, 30]) add(box(x, y, 2, 4, 6, 9, "mid"))

    for (const z of [48, 52, 56]) add(box(-5.4, -5.4, 10.8, 10.8, z, 0.7, "lo"))
    moving(
      [
        box(-25, -20, 50, 48, 17, 4, "hi", true),
        box(-5, -5, 10, 10, 21, 43, "mid"),
      ],
      [0, 0, -3.5]
    )
    add(head)
    add(box(-7, -7, 14, 14, 64, 4, "hi"), box(-3, -3, 6, 6, 68, 6, "mid"))
    add(box(-24, -2, 48, 4, 72, 2, "hi"))
    for (const x of [-26, 21]) add(box(x, -4, 5, 8, 71, 4, "mid"))
    add(
      box(-10, 32, 20, 5, 6, 0.4, "lo"),
      rules(-7, 34, 6.5, 13, 1),
      screws(-42, -32, 84, 71, 6.1)
    )
    return finish()
  }
  function emojis() {
    const o = object({ x: -48, y: -42, w: 96, d: 90, r: 3 }, 35)
    const { add, box, rules, screws, moving, base, finish } = o
    base({ x: -46, y: -40, w: 92, d: 84, r: 5 })
    add(box(-41, -35, 82, 74, 1, 7, "mid"), box(-34, -29, 68, 60, 8, 2, "lo"))
    for (const y of [-31, 29]) add(box(-36, y, 72, 2, 10, 4, "mid"))
    for (const x of [-36, 34]) add(box(x, -31, 2, 62, 10, 4, "mid"))
    // Individual removable pixel dies carry a smiling stamp face.
    for (let row = 0; row < 5; row++)
      for (let col = 0; col < 5; col++) {
        const face =
          (row === 1 && (col === 1 || col === 3)) ||
          (row === 3 && (col === 0 || col === 4)) ||
          (row === 4 && col > 0 && col < 4)
        add(
          box(
            -28 + col * 12,
            -23 + row * 10,
            10,
            8,
            10,
            face ? 5 : 1,
            face ? "hi" : "lo"
          )
        )
      }
    for (const x of [-40, 37]) add(box(x, -33, 3, 67, 8, 9, "hi"))
    const handle = [box(-40, -31, 80, 4, 17, 3, "mid")]
    for (const x of [-7, 4]) handle.push(box(x, -31, 3, 4, 20, 10, "mid"))
    handle.push(box(-7, -31, 14, 4, 30, 3, "hi", true))
    moving(handle, [0, 5, 0])
    add(
      box(-12, 34, 24, 4, 8, 0.4, "lo"),
      rules(-9, 35, 8.5, 17, 1),
      screws(-41, -35, 82, 74, 8.1)
    )
    return finish()
  }
  function labels() {
    const o = object({ x: -48, y: -39, w: 96, d: 94, r: 3 }, 46)
    const { add, box, rules, screws, slot, moving, base, finish } = o
    base({ x: -46, y: -37, w: 92, d: 88, r: 4 })
    add(box(-41, -32, 82, 77, 1, 6, "mid"))
    add(box(-34, -28, 68, 34, 7, 16, "mid"), box(-36, -30, 72, 37, 23, 3, "hi"))
    add(box(-31, -25, 62, 28, 26, 2, "lo"))
    for (const y of [-22, -16, -10]) add(box(-27, y, 54, 3, 28, 0.5, "mid"))
    for (const x of [-36, 32]) {
      add(box(x, 6, 4, 37, 7, 3, "mid"))
      for (const y of [6, 42]) add(box(x - 1, y, 6, 2, 7, 6, "hi"))
    }
    // Six cut tag blanks with supported holes and their own printed labels.
    for (let i = 0; i < 6; i++) {
      const x = -27 + (i % 3) * 19,
        y = 9 + Math.floor(i / 3) * 16
      add(
        box(x, y, 16, 13, 7, 0.7, "hi"),
        box(x + 1, y + 1, 14, 3, 7.7, 0.3, "lo")
      )
      add(slot(x + 2, y + 7, 2, 2, 7.8, "mid"), rules(x + 6, y + 6, 7.8, 7, 2))
    }
    add(box(-37, 3, 74, 4, 26, 3, "mid"))
    const carriage = [
      box(-29, 2, 16, 7, 29, 5, "hi", true),
      box(-25, 4, 8, 3, 34, 0.5, "lo"),
    ]
    moving(carriage, [16, 0, 0])
    for (const x of [-23, -4, 15])
      add(box(x, 36, 12, 6, 7, 1, "mid"), box(x + 4, 38, 4, 2, 8, 0.3, "hi"))
    add(
      box(-8, -24, 16, 5, 28.5, 0.4, "lo"),
      rules(-6, -22, 29, 11, 1),
      screws(-41, -32, 82, 77, 7.2)
    )
    return finish()
  }
  return {
    issues: issues(),
    initiatives: initiatives(),
    triage: triage(),
    cycles: cycles(),
    documents: documents(),
    emojis: emojis(),
    labels: labels(),
  }
}
