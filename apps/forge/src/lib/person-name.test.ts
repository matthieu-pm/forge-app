import { describe, expect, it } from "vitest"
import { formatPersonName, resolvePerson } from "./person-name"

describe("FOR-130 person names", () => {
  it("uses the selected field, then the alternate, then a stable account suffix without email", () => {
    const person = {
      id: "account-1",
      name: "  Alice Smith  ",
      username: "alice",
    }
    expect(formatPersonName(person, "username")).toBe("alice")
    expect(formatPersonName(person, "full-name")).toBe("Alice Smith")
    expect(formatPersonName({ ...person, username: " " }, "username")).toBe(
      "Alice Smith"
    )
    expect(formatPersonName({ ...person, name: "" }, "full-name")).toBe("alice")
    expect(formatPersonName({ id: person.id, name: " " }, "username")).toBe(
      "Member · accoun"
    )
  })

  it("disambiguates case-insensitive collisions using username, then a unique account prefix", () => {
    const people = [
      { id: "shared-a", name: "Alex", username: "one" },
      { id: "shared-b", name: "ALEX", username: "two" },
      { id: "shared-c", name: "Alex", username: "same" },
      { id: "shared-d", name: "Alex", username: "same" },
    ]
    expect(
      people.map((person) => formatPersonName(person, "full-name", people))
    ).toEqual([
      "Alex · @one",
      "ALEX · @two",
      "Alex · @same · shared-c",
      "Alex · @same · shared-d",
    ])
    for (const format of ["username", "full-name"] as const) {
      const labels = people.map((person) =>
        formatPersonName(person, format, people)
      )
      expect(new Set(labels.map((label) => label.toLowerCase())).size).toBe(
        people.length
      )
      expect(
        people.map((person) =>
          formatPersonName(person, format, [...people].reverse())
        )
      ).toEqual(labels)
    }
    expect(people[0]).toEqual({ id: "shared-a", name: "Alex", username: "one" })
  })

  it("resolves immutable IDs first and accepts a legacy name only when unique", () => {
    const people = [
      { id: "one", name: "Alex" },
      { id: "two", name: "Alex" },
      { id: "Alex", name: "Other" },
    ]
    expect(resolvePerson(people, "Alex")).toBe(people[2])
    expect(resolvePerson(people.slice(0, 2), "Alex")).toBeUndefined()
    expect(resolvePerson(people, "Other")).toBe(people[2])
    expect(resolvePerson(people, "two")).toBe(people[1])
  })

  it("also separates a real full name that matches a generated collision label", () => {
    const people = [
      { id: "first", name: "Alex", username: "one" },
      { id: "second", name: "Alex", username: "two" },
      { id: "third", name: "Alex · @one", username: "three" },
    ]
    const labels = people.map((person) =>
      formatPersonName(person, "full-name", people)
    )
    expect(new Set(labels).size).toBe(3)
    expect(labels[0]).toBe("Alex · @one · first")
    expect(labels[2]).toBe("Alex · @one · third")
  })

  it.each([
    ["abcdef-1", "ABCDEF-2"],
    ["abcdef", "ABCDEF"],
    ["ＡＢＣＤＥＦ", "abcdef"],
  ])(
    "keeps normalized account suffixes unique for %s and %s",
    (first, second) => {
      const people = [
        { id: first, name: "Alex" },
        { id: second, name: "Alex" },
      ]
      const labels = people.map((person) =>
        formatPersonName(person, "full-name", people)
      )
      expect(
        new Set(labels.map((label) => label.normalize("NFKC").toLowerCase()))
          .size
      ).toBe(2)
      expect(
        people.map((person) =>
          formatPersonName(person, "full-name", [...people].reverse())
        )
      ).toEqual(labels)
    }
  )
})
