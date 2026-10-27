import { Suspense, lazy } from "react"
import { Node, mergeAttributes } from "@tiptap/core"
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react"
import type { NodeViewProps } from "@tiptap/react"
import { documentChartSchema } from "@/lib/document-chart"

const DocumentChart = lazy(() =>
  import("@/components/documents/document-chart").then((module) => ({
    default: module.DocumentChart,
  }))
)

function ChartView({ node }: NodeViewProps) {
  const result = documentChartSchema.safeParse(node.attrs.chart)
  return (
    <NodeViewWrapper contentEditable={false}>
      {result.success ? (
        <Suspense
          fallback={
            <p role="status" className="py-8 text-xs text-muted-foreground">
              Loading chart…
            </p>
          }
        >
          <DocumentChart chart={result.data} />
        </Suspense>
      ) : (
        <p role="alert">This chart snapshot could not be read.</p>
      )}
    </NodeViewWrapper>
  )
}

export const AnalyticsChart = Node.create({
  name: "analyticsChart",
  group: "block",
  atom: true,
  addAttributes: () => ({
    chart: {
      default: null,
      parseHTML: (element) => {
        try {
          return JSON.parse(
            element.getAttribute("data-chart-snapshot") ?? "null"
          )
        } catch {
          return null
        }
      },
      renderHTML: (attrs) => ({
        "data-chart-snapshot": JSON.stringify(attrs.chart),
      }),
    },
  }),
  parseHTML: () => [{ tag: "figure[data-analytics-chart]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "figure",
    mergeAttributes(HTMLAttributes, { "data-analytics-chart": "true" }),
  ],
  addNodeView: () => ReactNodeViewRenderer(ChartView),
})
