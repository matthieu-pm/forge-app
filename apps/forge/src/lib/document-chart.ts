import { z } from "zod"

// A self-contained snapshot: documents remain readable after their source changes.
export const documentChartSchema = z
  .object({
    title: z.string().min(1).max(200),
    kind: z.enum(["line", "bar", "funnel", "horizontalBar"]),
    unit: z.enum(["count", "percent"]),
    series: z.array(z.string().min(1).max(100)).min(1).max(3),
    points: z
      .array(
        z.object({
          label: z.string().min(1).max(100),
          values: z.array(z.number().finite().nonnegative()).min(1).max(3),
        })
      )
      .min(1)
      .max(100),
    source: z.object({
      provider: z.enum(["PostHog", "Amplitude"]),
      account: z.string().min(1).max(100),
      product: z.string().min(1).max(100),
      period: z.string().min(1).max(100),
      simulated: z.boolean(),
    }),
    caption: z.string().max(2000),
  })
  .refine(
    (chart) =>
      chart.points.every(
        (point) =>
          point.values.length === chart.series.length &&
          (chart.unit !== "percent" ||
            point.values.every((value) => value <= 100))
      ),
    "Chart values must match their series and unit."
  )

export type DocumentChart = z.infer<typeof documentChartSchema>
