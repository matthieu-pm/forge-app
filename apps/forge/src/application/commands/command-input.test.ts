import { describe, expect, it } from "vitest"
import { commandInputHash } from "./command-input"

describe("command identity", () => {
  it("canonicalizes nested object keys while preserving array order and values", () => {
    expect(commandInputHash({ a: 1, b: { x: [1, 2], y: null } })).toBe(
      commandInputHash({ b: { y: null, x: [1, 2] }, a: 1 })
    )
    expect(commandInputHash([1, 2])).not.toBe(commandInputHash([2, 1]))
    expect(commandInputHash({ a: null })).not.toBe(commandInputHash({}))
  })
  it.each([
    undefined,
    NaN,
    Infinity,
    new Date(),
    { x: undefined },
    [undefined],
    Array(1),
    1n,
  ])("rejects non-JSON input %#", (value) => {
    expect(() => commandInputHash(value)).toThrow(TypeError)
  })
})
