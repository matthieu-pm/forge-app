import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Editor } from "@tiptap/core"
import {
  newSignalDocument,
  signalDocumentsKey,
  useSignalDocuments,
} from "./signals-documents"
import { sampleSignalInsights } from "./signals-insights"
import { documentPlainText, teamDocumentBody } from "./team-documents"
import { teamResourceSchema } from "./team-home-state"
import { documentChartSchema } from "./document-chart"
import { documentSchema } from "./template-contract"
import { signalInsightChart } from "./signals-insight-charts"
import { productStorage } from "@/lib/product-storage"
import { richEditorExtensions } from "@/components/templates/rich-editor"

const scope = { workspaceId: "workspace", userId: "user" }
beforeEach(() => productStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("Signals draft documents", () => {
  it("uses document validation and preserves chart snapshots through rich editor JSON and HTML", () => {
    for (const insight of sampleSignalInsights) {
      const document = newSignalDocument(insight)
      expect(teamResourceSchema.safeParse(document).success).toBe(true)
      expect(documentSchema.safeParse(document.body).success).toBe(true)
      const editor = new Editor({
        extensions: richEditorExtensions,
        content: teamDocumentBody(document),
      })
      const html = editor.getHTML()
      const reopened = new Editor({
        extensions: richEditorExtensions,
        content: html,
      })
      expect(reopened.getJSON()).toMatchObject({
        content: expect.arrayContaining([
          {
            type: "analyticsChart",
            attrs: { chart: signalInsightChart(insight) },
          },
        ]),
      })
      expect(documentPlainText(editor.getJSON())).toContain(insight.summary)
      expect(documentPlainText(editor.getJSON())).toContain("Simulated data")
      editor.destroy()
      reopened.destroy()
    }
  })
  it("keeps simulated source identities separate and validates the report totals", () => {
    const charts = sampleSignalInsights.map(signalInsightChart)
    expect(new Set(charts.map((chart) => chart.source.provider))).toEqual(
      new Set(["PostHog", "Amplitude"])
    )
    expect(new Set(charts.map((chart) => chart.kind)).size).toBe(4)
    expect(
      charts.every(
        (chart) =>
          chart.source.simulated && documentChartSchema.safeParse(chart).success
      )
    ).toBe(true)
    const invite = charts[0].points.map((point) => point.values[0])
    expect(invite[0] - invite[1]).toBe(181)
    expect(Math.round((invite[1] / invite[0]) * 100)).toBe(42)
    expect(charts[2].points.at(-1)?.values[0]).toBe(19)
    const discovered = charts[3].points.reduce(
      (sum, point) => sum + point.values[0],
      0
    )
    const eligible = charts[3].points
      .flatMap((point) => point.values)
      .reduce((sum, value) => sum + value, 0)
    expect(discovered / eligible).toBe(0.14)
  })
  it("rejects malformed chart snapshots instead of accepting invalid documents", () => {
    const chart = signalInsightChart(sampleSignalInsights[0])
    for (const invalid of [
      { ...chart, points: [{ label: "Broken", values: [-1] }] },
      { ...chart, points: [{ label: "Broken", values: [1, 2] }] },
      {
        ...chart,
        unit: "percent",
        points: [{ label: "Broken", values: [101] }],
      },
    ]) {
      expect(
        documentSchema.safeParse({
          type: "doc",
          content: [{ type: "analyticsChart", attrs: { chart: invalid } }],
        }).success
      ).toBe(false)
    }
  })
  it("retains failed edits for retry, saves one draft, and isolates user/workspace storage", () => {
    const initial = newSignalDocument(sampleSignalInsights[0])
    const { result, unmount } = renderHook(() => useSignalDocuments(scope))
    const setItem = vi
      .spyOn(productStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("Quota")
      })
    act(() => {
      result.current.save({ ...initial, title: "Edited insight" })
    })
    expect(result.current.error).toContain("could not be saved")
    expect(result.current.documents[initial.id].title).toBe("Edited insight")
    setItem.mockRestore()
    act(() => {
      result.current.retry()
    })
    expect(result.current.error).toBe("")
    unmount()
    const reopened = renderHook(() => useSignalDocuments(scope))
    expect(Object.keys(reopened.result.current.documents)).toHaveLength(1)
    expect(reopened.result.current.documents[initial.id].title).toBe(
      "Edited insight"
    )
    const otherUser = renderHook(() =>
      useSignalDocuments({ ...scope, userId: "other" })
    )
    const otherWorkspace = renderHook(() =>
      useSignalDocuments({ ...scope, workspaceId: "other" })
    )
    expect(otherUser.result.current.documents).toEqual({})
    expect(otherWorkspace.result.current.documents).toEqual({})
  })
  it("preserves unreadable saved data and prevents overwriting it", () => {
    productStorage.setItem(signalDocumentsKey(scope), "not valid JSON")
    const { result } = renderHook(() => useSignalDocuments(scope))
    expect(result.current.readError).toBe(true)
    act(() => {
      result.current.save(newSignalDocument(sampleSignalInsights[0]))
    })
    expect(productStorage.getItem(signalDocumentsKey(scope))).toBe(
      "not valid JSON"
    )
  })
})
