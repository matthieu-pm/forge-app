import { useState } from "react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts"
import type { DocumentChart as ChartSnapshot } from "@/lib/document-chart"
import { Button } from "@/components/ui/button"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"

const colors = ["var(--primary)", "var(--muted-foreground)", "var(--chart-3)"]

export function DocumentChart({ chart }: { chart: ChartSnapshot }) {
  const [table, setTable] = useState(false)
  const data = chart.points.map((point) => ({
    label: point.label,
    ...Object.fromEntries(
      point.values.map((value, index) => [`value${index}`, value])
    ),
  }))
  const config = Object.fromEntries(
    chart.series.map((label, index) => [
      `value${index}`,
      { label, color: colors[index] },
    ])
  )
  const format = (value: number) =>
    `${value.toLocaleString()}${chart.unit === "percent" ? "%" : ""}`
  const horizontal = chart.kind === "funnel" || chart.kind === "horizontalBar"
  const source = chart.source
  return (
    <figure
      aria-label={chart.title}
      className="my-5 overflow-hidden rounded-xl border border-border/60 bg-muted/10 p-4 text-[12px] leading-5"
    >
      <figcaption>
        <div className="flex items-start justify-between gap-3">
          <span className="font-medium">{chart.title}</span>
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={table}
            onClick={() => setTable(!table)}
          >
            {table ? "Hide data" : "View data"}
          </Button>
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground">
          {source.provider} · {source.account} / {source.product}
          {source.simulated && " · Simulated"}
        </div>
      </figcaption>
      <ChartContainer
        className="mt-5 aspect-auto h-[210px] w-full"
        config={config}
      >
        {chart.kind === "line" ? (
          <LineChart
            data={data}
            margin={{ left: -20, right: 12, top: 8 }}
            accessibilityLayer
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={10}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickFormatter={format}
              domain={chart.unit === "percent" ? [0, 100] : [0, "auto"]}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            {chart.series.map((_, index) => (
              <Line
                key={index}
                dataKey={`value${index}`}
                type="linear"
                stroke={`var(--color-value${index})`}
                strokeWidth={2}
                dot={{ r: 3 }}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        ) : (
          <BarChart
            data={data}
            layout={horizontal ? "vertical" : "horizontal"}
            margin={{ left: horizontal ? 0 : -20, right: 12, top: 8 }}
            accessibilityLayer
          >
            <CartesianGrid vertical={horizontal} horizontal={!horizontal} />
            {horizontal ? (
              <>
                <XAxis
                  type="number"
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={format}
                  domain={chart.unit === "percent" ? [0, 100] : [0, "auto"]}
                />
                <YAxis
                  dataKey="label"
                  type="category"
                  width={145}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 10 }}
                />
              </>
            ) : (
              <>
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={10}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={format}
                  domain={chart.unit === "percent" ? [0, 100] : [0, "auto"]}
                />
              </>
            )}
            <ChartTooltip content={<ChartTooltipContent />} />
            {chart.series.map((_, index) => (
              <Bar
                key={index}
                dataKey={`value${index}`}
                fill={`var(--color-value${index})`}
                fillOpacity={index === 1 ? 0.25 : 0.9}
                radius={horizontal ? [0, 3, 3, 0] : [3, 3, 0, 0]}
                maxBarSize={horizontal ? 30 : 42}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        )}
      </ChartContainer>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        {chart.series.map((label, index) => (
          <span key={label} className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-sm"
              style={{
                backgroundColor: colors[index],
                opacity: index === 1 ? 0.4 : 1,
              }}
            />
            {label}
          </span>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">{source.period}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">{chart.caption}</p>
      {table && (
        <div className="mt-4 overflow-x-auto border-t border-border/50 pt-3">
          <table className="w-full text-left text-[11px] tabular-nums">
            <caption className="sr-only">{chart.title} data</caption>
            <thead>
              <tr>
                <th scope="col" className="py-2 font-medium">
                  Segment / time
                </th>
                {chart.series.map((label) => (
                  <th
                    key={label}
                    scope="col"
                    className="px-2 py-2 text-right font-medium"
                  >
                    {label}
                    {chart.unit === "percent" && " (%)"}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {chart.points.map((point) => (
                <tr key={point.label} className="border-t border-border/30">
                  <th scope="row" className="py-2 font-normal">
                    {point.label}
                  </th>
                  {point.values.map((value, index) => (
                    <td key={index} className="px-2 py-2 text-right">
                      {format(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  )
}
