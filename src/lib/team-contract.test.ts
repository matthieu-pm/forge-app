import { describe, expect, it } from "vitest"

import {
  createTeamInputSchema,
  deleteTeamInputSchema,
  slugifyTeamName,
  updateTeamInputSchema,
} from "./team-contract"

describe("createTeamInputSchema", () => {
  const validInput = {
    name: "Engineering",
    identifier: "ENG",
    icon: {
      kind: "icon" as const,
      value: "UserGroup03Icon",
      color: "#818cf8" as const,
    },
    timezone: "Europe/Paris",
  }

  it("normalizes names and identifiers", () => {
    expect(
      createTeamInputSchema.parse({
        ...validInput,
        name: "  Engineering  ",
        identifier: " eng ",
      })
    ).toMatchObject({ name: "Engineering", identifier: "ENG" })
  })

  it("rejects identifiers that do not start with a letter", () => {
    expect(() =>
      createTeamInputSchema.parse({ ...validInput, identifier: "123" })
    ).toThrow()
  })

  it("rejects unknown timezones", () => {
    expect(() =>
      createTeamInputSchema.parse({
        ...validInput,
        timezone: "Europe/Definitely-Not-A-City",
      })
    ).toThrow()
  })

  it("rejects colors outside the supported palette", () => {
    expect(() =>
      createTeamInputSchema.parse({
        ...validInput,
        icon: { ...validInput.icon, color: "#000000" },
      })
    ).toThrow()
  })
})

describe("deleteTeamInputSchema", () => {
  it("normalizes the team slug and confirmation name", () => {
    expect(
      deleteTeamInputSchema.parse({
        slug: " Platform-API ",
        confirmationName: " Platform API ",
      })
    ).toEqual({
      slug: "platform-api",
      confirmationName: "Platform API",
    })
  })

  it("rejects malformed team slugs", () => {
    expect(() =>
      deleteTeamInputSchema.parse({
        slug: "../platform-api",
        confirmationName: "Platform API",
      })
    ).toThrow()
  })
})

describe("updateTeamInputSchema", () => {
  it("normalizes editable team settings", () => {
    expect(
      updateTeamInputSchema.parse({
        slug: " Engineering ",
        settings: {
          icon: {
            kind: "emoji",
            value: "🛠️",
            color: "#38bdf8",
          },
          name: " Platform ",
          identifier: " plt ",
          description: " Core systems ",
          estimationScheme: "fibonacci",
        },
      })
    ).toEqual({
      slug: "engineering",
      settings: {
        icon: {
          kind: "emoji",
          value: "🛠️",
          color: "#38bdf8",
        },
        name: "Platform",
        identifier: "PLT",
        description: "Core systems",
        estimationScheme: "fibonacci",
      },
    })
  })

  it("rejects an empty settings patch", () => {
    expect(() =>
      updateTeamInputSchema.parse({ slug: "engineering", settings: {} })
    ).toThrow()
  })
})

describe("slugifyTeamName", () => {
  it("creates stable URL-safe slugs", () => {
    expect(slugifyTeamName("  Équipe Platform & API  ")).toBe(
      "equipe-platform-api"
    )
  })

  it("returns an empty slug when no URL-safe characters remain", () => {
    expect(slugifyTeamName("🚀")).toBe("")
  })
})
