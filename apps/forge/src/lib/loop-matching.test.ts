import { describe, expect, it } from "vitest"
import {
  loopCommandSchema,
  loopFieldsSchema,
  loopScheduleTriggerSchema,
  loopTriggerSchema,
} from "./loop-contract"
import {
  loopLocalDateTime,
  loopScheduleStart,
  matchesLoopConditions,
  matchesLoopEvent,
  nextLoopScheduledAt,
} from "./loop-matching"
import type { LoopFields, LoopTrigger } from "./loop-contract"

const fields: LoopFields = {
  name: "Investigate",
  description: "",
  instructions: "Investigate the incoming issue.",
  conditions: [],
  reasoning: "auto",
  teamAccess: "this-team",
  trigger: { kind: "event", entity: "issue", event: "created" },
}
const schedule = (
  overrides: Partial<Extract<LoopTrigger, { kind: "schedule" }>> = {}
): Extract<LoopTrigger, { kind: "schedule" }> => ({
  kind: "schedule",
  unit: "days",
  interval: 1,
  startAt: "2026-03-28T08:00:00.000Z",
  timeZone: "Europe/Paris",
  ...overrides,
})
describe("Loop event matching", () => {
  it("matches explicit no-value filters and scalar removals without inventing collection items", () => {
    for (const field of ["assignee", "project", "cycle", "labels"] as const) {
      expect(
        matchesLoopConditions(
          [{ field, operator: "is", values: ["__none__"] }],
          { [field]: field === "labels" ? [] : null }
        )
      ).toBe(true)
      expect(
        matchesLoopConditions(
          [{ field, operator: "isNot", values: ["__none__"] }],
          { [field]: "present" }
        )
      ).toBe(true)
      expect(
        matchesLoopConditions(
          [{ field, operator: "any", values: ["__none__", "present"] }],
          { [field]: "" }
        )
      ).toBe(true)
      expect(
        matchesLoopConditions(
          [{ field, operator: "none", values: ["__none__"] }],
          { [field]: [] }
        )
      ).toBe(false)
    }
    const event = {
      entity: "issue" as const,
      event: "updated" as const,
      before: { assignee: "alice", labels: ["bug"] },
      after: { assignee: null, labels: [] },
    }
    expect(
      matchesLoopEvent(
        {
          ...fields,
          trigger: {
            kind: "event",
            entity: "issue",
            event: "changed",
            property: "assignee",
            values: ["__none__"],
          },
        },
        event
      )
    ).toBe(true)
    expect(
      matchesLoopEvent(
        {
          ...fields,
          trigger: {
            kind: "event",
            entity: "issue",
            event: "removed",
            property: "labels",
            values: ["__none__"],
          },
        },
        event
      )
    ).toBe(false)
  })
  it("requires the actual transition and destination qualifier", () => {
    const trigger: LoopTrigger = {
      kind: "event",
      entity: "issue",
      event: "changed",
      property: "status",
      values: ["done"],
    }
    expect(
      matchesLoopEvent(
        { ...fields, trigger },
        {
          entity: "issue",
          event: "updated",
          before: { status: "todo" },
          after: { status: "done" },
        }
      )
    ).toBe(true)
    expect(
      matchesLoopEvent(
        { ...fields, trigger },
        {
          entity: "issue",
          event: "updated",
          before: { status: "done" },
          after: { status: "done", title: "Changed" },
        }
      )
    ).toBe(false)
    expect(
      matchesLoopEvent(
        { ...fields, trigger },
        {
          entity: "project",
          event: "updated",
          before: { status: "todo" },
          after: { status: "done" },
        }
      )
    ).toBe(false)
  })
  it("matches removed labels against the difference and post-change filters", () => {
    const trigger: LoopTrigger = {
      kind: "event",
      entity: "issue",
      event: "removed",
      property: "labels",
      values: ["bug"],
    }
    const event = {
      entity: "issue" as const,
      event: "updated" as const,
      before: { labels: ["bug", "mobile"] },
      after: { labels: ["mobile"] },
    }
    expect(
      matchesLoopEvent(
        {
          ...fields,
          trigger,
          conditions: [
            { field: "labels", operator: "any", values: ["mobile"] },
          ],
        },
        event
      )
    ).toBe(true)
    expect(
      matchesLoopEvent(
        {
          ...fields,
          trigger,
          conditions: [{ field: "labels", operator: "any", values: ["bug"] }],
        },
        event
      )
    ).toBe(false)
  })
  it("triage activates when its full condition set begins matching", () => {
    const definition: LoopFields = {
      ...fields,
      trigger: { kind: "event", entity: "issue", event: "triage" },
      conditions: [{ field: "priority", operator: "is", values: ["high"] }],
    }
    expect(
      matchesLoopEvent(definition, {
        entity: "issue",
        event: "updated",
        before: { triage: true, priority: "low" },
        after: { triage: true, priority: "high" },
      })
    ).toBe(true)
    expect(
      matchesLoopEvent(definition, {
        entity: "issue",
        event: "updated",
        before: { triage: true, priority: "high" },
        after: { triage: true, priority: "high", title: "Still matching" },
      })
    ).toBe(false)
    expect(
      matchesLoopEvent(definition, {
        entity: "issue",
        event: "created",
        before: null,
        after: { triage: true, priority: "high" },
      })
    ).toBe(true)
  })
  it("uses AND across conditions, OR across values, and literal case-insensitive text", () => {
    expect(
      matchesLoopConditions(
        [
          { field: "priority", operator: "is", values: ["urgent", "high"] },
          { field: "title", operator: "contains", values: ["A.*BUG"] },
        ],
        { priority: "high", title: "An a.*bug report" }
      )
    ).toBe(true)
    expect(
      matchesLoopConditions(
        [{ field: "title", operator: "contains", values: ["A.*BUG"] }],
        { title: "An arbitrary bug report" }
      )
    ).toBe(false)
    expect(
      matchesLoopConditions(
        [{ field: "labels", operator: "none", values: ["secret"] }],
        { labels: ["public"] }
      )
    ).toBe(true)
  })
  it("normalizes optional trigger keys before they reach the finite-JSON command hash", () => {
    const parsed = loopFieldsSchema.parse({
      ...fields,
      trigger: {
        kind: "event",
        entity: "issue",
        event: "comment",
        commentMode: "contains",
        commentText: "bug",
        mentionIds: undefined,
      },
    })
    expect(Object.hasOwn(parsed.trigger, "mentionIds")).toBe(false)
    const weekly = loopFieldsSchema.parse({
      ...fields,
      trigger: {
        kind: "schedule",
        unit: "days",
        interval: 1,
        startAt: "2026-11-03T12:00:00Z",
        timeZone: "Europe/Paris",
        weekdays: undefined,
      },
    })
    expect(Object.hasOwn(weekly.trigger, "weekdays")).toBe(false)
  })
  it("rejects unsupported combinations, arbitrary field paths, excess conditions and enabled smuggling", () => {
    for (const trigger of [
      { kind: "event", entity: "team", event: "triage" },
      { kind: "event", entity: "issue", event: "started" },
      {
        kind: "event",
        entity: "cycle",
        event: "changed",
        property: "priority",
      },
      { kind: "event", entity: "issue", event: "created", property: "status" },
    ])
      expect(loopTriggerSchema.safeParse(trigger).success).toBe(false)
    expect(
      loopFieldsSchema.safeParse({
        ...fields,
        conditions: [
          { field: "__proto__.admin", operator: "is", values: ["true"] },
        ],
      }).success
    ).toBe(false)
    expect(
      loopFieldsSchema.safeParse({
        ...fields,
        conditions: Array.from({ length: 9 }, () => ({
          field: "priority",
          operator: "is",
          values: ["high"],
        })),
      }).success
    ).toBe(false)
    expect(
      loopCommandSchema.safeParse({
        action: "save",
        id: crypto.randomUUID(),
        expectedRevision: 1,
        fields: { ...fields, enabled: true },
      }).success
    ).toBe(false)
  })
})
describe("Loop groups and comment rules", () => {
  it("matches nested all/any groups and bounds total leaves and depth", () => {
    const condition = {
      field: "priority" as const,
      operator: "is" as const,
      values: ["high"],
    }
    const groups = [
      {
        operator: "or" as const,
        conditions: [
          condition,
          {
            operator: "and" as const,
            conditions: [
              {
                field: "labels" as const,
                operator: "any" as const,
                values: ["bug"],
              },
              {
                field: "status" as const,
                operator: "is" as const,
                values: ["todo"],
              },
            ],
          },
        ],
      },
    ]
    expect(
      matchesLoopConditions(groups, {
        priority: "low",
        labels: ["bug"],
        status: "todo",
      })
    ).toBe(true)
    expect(
      matchesLoopConditions(groups, {
        priority: "low",
        labels: ["bug"],
        status: "done",
      })
    ).toBe(false)
    expect(
      loopFieldsSchema.safeParse({
        ...fields,
        conditions: [
          {
            operator: "or",
            conditions: Array.from({ length: 8 }, () => condition),
          },
          condition,
        ],
      }).success
    ).toBe(false)
    let deep: unknown = condition
    for (let i = 0; i < 6; i++) deep = { operator: "and", conditions: [deep] }
    expect(
      loopFieldsSchema.safeParse({ ...fields, conditions: [deep] }).success
    ).toBe(false)
  })
  it("distinguishes replies, literal text and linked mentions", () => {
    const event = {
      entity: "issue" as const,
      event: "comment" as const,
      before: {},
      after: {},
      comment: {
        text: "Please ask @Alice about A.*BUG",
        parentId: "parent",
        mentionIds: [] as Array<string>,
      },
    }
    const base = {
      ...fields,
      trigger: {
        kind: "event" as const,
        entity: "issue" as const,
        event: "comment" as const,
      },
    }
    expect(matchesLoopEvent(base, event)).toBe(true)
    expect(
      matchesLoopEvent(
        { ...base, trigger: { ...base.trigger, commentMode: "newThread" } },
        event
      )
    ).toBe(false)
    expect(
      matchesLoopEvent(
        { ...base, trigger: { ...base.trigger, commentMode: "newThread" } },
        { ...event, comment: { ...event.comment, parentId: "" } }
      )
    ).toBe(true)
    expect(
      matchesLoopEvent(
        {
          ...base,
          trigger: {
            ...base.trigger,
            commentMode: "contains",
            commentText: "a.*bug",
          },
        },
        event
      )
    ).toBe(true)
    const member = "better-auth-member-id"
    const mention = {
      ...base,
      trigger: {
        ...base.trigger,
        commentMode: "mentions" as const,
        mentionIds: [member],
      },
    }
    expect(matchesLoopEvent(mention, event)).toBe(false)
    expect(
      matchesLoopEvent(mention, {
        ...event,
        comment: { ...event.comment, mentionIds: [member] },
      })
    ).toBe(true)
    expect(
      loopFieldsSchema.safeParse({
        ...base,
        trigger: { ...base.trigger, commentMode: "mentions", mentionIds: [] },
      }).success
    ).toBe(false)
    expect(
      loopFieldsSchema.safeParse({
        ...fields,
        trigger: {
          ...fields.trigger,
          commentMode: "contains",
          commentText: "test",
        },
      }).success
    ).toBe(false)
  })
})
describe("Loop schedules", () => {
  it("preserves daily wall-clock time across DST", () => {
    const next = nextLoopScheduledAt(
      schedule(),
      new Date("2026-03-28T08:00:00Z")
    )
    expect(next.toISOString()).toBe("2026-03-29T07:00:00.000Z")
    expect(loopLocalDateTime(next, "Europe/Paris")).toBe("2026-03-29T09:00")
  })
  it("moves missing wall time forward and runs ambiguous wall time once", () => {
    expect(
      nextLoopScheduledAt(
        schedule({ startAt: "2026-03-28T01:30:00Z" }),
        new Date("2026-03-28T01:30:00Z")
      ).toISOString()
    ).toBe("2026-03-29T01:30:00.000Z")
    const s = schedule({ startAt: "2026-10-24T00:30:00Z" })
    const repeated = nextLoopScheduledAt(s, new Date(s.startAt))
    expect(repeated.toISOString()).toBe("2026-10-25T00:30:00.000Z")
    expect(nextLoopScheduledAt(s, repeated).toISOString()).toBe(
      "2026-10-26T01:30:00.000Z"
    )
  })
  it("handles hourly intervals, future first runs and coalesces missed ticks", () => {
    const s = schedule({ unit: "hours", interval: 3 })
    expect(
      nextLoopScheduledAt(s, new Date("2026-03-01T00:00:00Z")).toISOString()
    ).toBe(s.startAt)
    expect(
      nextLoopScheduledAt(s, new Date("2026-03-29T10:00:00Z")).toISOString()
    ).toBe("2026-03-29T11:00:00.000Z")
  })
  it("runs selected weekdays only in active interval weeks", () => {
    const s = schedule({
      unit: "weeks",
      interval: 2,
      weekdays: [1, 5],
      startAt: "2026-11-02T08:00:00Z",
    })
    expect(nextLoopScheduledAt(s, new Date(s.startAt)).toISOString()).toBe(
      "2026-11-06T08:00:00.000Z"
    )
    expect(
      nextLoopScheduledAt(s, new Date("2026-11-06T08:00:00Z")).toISOString()
    ).toBe("2026-11-16T08:00:00.000Z")
  })
  it("clamps short months while retaining original month-day anchors", () => {
    const s = schedule({ unit: "months", startAt: "2026-01-31T08:00:00Z" })
    const february = nextLoopScheduledAt(s, new Date(s.startAt))
    expect(february.toISOString()).toBe("2026-02-28T08:00:00.000Z")
    expect(nextLoopScheduledAt(s, february).toISOString()).toBe(
      "2026-03-31T07:00:00.000Z"
    )
    expect(
      nextLoopScheduledAt(
        schedule({ unit: "years", startAt: "2024-02-29T08:00:00Z" }),
        new Date("2024-02-29T08:00:00Z")
      ).toISOString()
    ).toBe("2025-02-28T08:00:00.000Z")
  })
  it("validates zones/weekdays and interprets selected timezone independently of browser", () => {
    expect(
      loopScheduleTriggerSchema.safeParse(
        schedule({ unit: "weeks", weekdays: [] })
      ).success
    ).toBe(false)
    expect(
      loopScheduleTriggerSchema.safeParse(
        schedule({ unit: "weeks", weekdays: [1, 1] })
      ).success
    ).toBe(false)
    expect(
      loopScheduleTriggerSchema.safeParse(
        schedule({ timeZone: "Mars/Olympus" })
      ).success
    ).toBe(false)
    expect(loopScheduleStart("2026-11-02T09:00", "America/New_York")).toBe(
      "2026-11-02T14:00:00.000Z"
    )
  })
})
