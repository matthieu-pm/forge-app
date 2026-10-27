import { useId, useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowUpRight01Icon,
  Calendar03Icon,
  Cancel01Icon,
  FilterHorizontalIcon,
  Link01Icon,
  MoreHorizontalIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons"
import {
  SignalsAccountScope,
  SignalsConnectionsDialog,
  signalsPill,
  signalsSurface,
} from "./signals-connections"
import type {
  SignalBreakdown,
  SignalDimension,
  SignalFilters,
  SignalMetric,
} from "@/lib/signals-demo"
import {
  buildSignalSeries,
  createDemoSessions,
  selectSignalSessions,
  signalBreakdown,
  signalChange,
  signalDate,
  summarizeSignals,
} from "@/lib/signals-demo"
import { Button } from "@/components/ui/button"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { DropdownChevron } from "@/components/ui/dropdown-chevron"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  resolveSignalScope,
  sampleSignalAccounts,
} from "@/lib/signals-accounts"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

const number = new Intl.NumberFormat("en-US")
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
})
const dateLabel = (value: string | Date) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(value))
const metrics: Array<{ key: SignalMetric; label: string; definition: string }> =
  [
    {
      key: "users",
      label: "Active users",
      definition:
        "Unique users with at least one session in the selected period.",
    },
    {
      key: "sessions",
      label: "Sessions",
      definition: "Total product sessions in the selected period.",
    },
    {
      key: "interactions",
      label: "Feature interactions",
      definition: "Total tracked feature events in the selected period.",
    },
    {
      key: "returning",
      label: "Returning users",
      definition:
        "Active users whose first session occurred before the selected period.",
    },
  ]
const dimensions: Record<
  SignalDimension,
  { title: string; unit: string; definition: string }
> = {
  features: {
    title: "Features",
    unit: "Users",
    definition:
      "Unique users who used each feature. Adoption is the percentage of active users, so percentages can overlap.",
  },
  pages: {
    title: "Pages",
    unit: "Views",
    definition:
      "Total page views, including repeat visits. Percentages are shares of all page views.",
  },
  events: {
    title: "Events",
    unit: "Events",
    definition:
      "Total tracked feature events. Percentages are shares of all feature interactions.",
  },
  sources: {
    title: "Sources",
    unit: "Sessions",
    definition: "Sessions grouped by their referral source.",
  },
  devices: {
    title: "Devices",
    unit: "Users",
    definition: "Unique active users grouped by device.",
  },
  browsers: {
    title: "Browsers",
    unit: "Users",
    definition: "Unique active users grouped by browser.",
  },
  countries: {
    title: "Countries",
    unit: "Users",
    definition: "Unique active users grouped by country.",
  },
}
const controlClass =
  "h-7 gap-1.5 rounded-full border border-border/40 bg-muted/55 px-3 text-xs font-normal text-muted-foreground"

export function SignalsDashboard({ onExit }: { onExit: () => void }) {
  const [scope, setScope] = useState({
    accountId: sampleSignalAccounts[0].id,
    projectId: sampleSignalAccounts[0].projects[0].id,
  })
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const { account, project } = resolveSignalScope(
    scope.accountId,
    scope.projectId
  )
  const sampleSessions = useMemo(
    () => createDemoSessions(project.seed),
    [project.seed]
  )
  const [days, setDays] = useState(30)
  const [metric, setMetric] = useState<SignalMetric>("users")
  const [compare, setCompare] = useState(true)
  const [filters, setFilters] = useState<SignalFilters>({})
  const [expanded, setExpanded] = useState<SignalDimension | null>(null)
  const [search, setSearch] = useState("")
  const [detail, setDetail] = useState<{
    dimension: SignalDimension
    row: SignalBreakdown
  } | null>(null)
  const gradientId = useId().replace(/:/g, "")
  function selectScope(accountId: string, projectId?: string) {
    const next = resolveSignalScope(accountId, projectId)
    setScope({ accountId: next.account.id, projectId: next.project.id })
    setFilters({})
    setExpanded(null)
    setDetail(null)
  }
  const { current, totals, previousTotals, series } = useMemo(() => {
    const start = 180 - days
    const selected = selectSignalSessions(sampleSessions, start, 179, filters)
    const previous = selectSignalSessions(
      sampleSessions,
      start - days,
      start - 1,
      filters
    )
    return {
      current: selected,
      totals: summarizeSignals(selected, start),
      previousTotals: summarizeSignals(previous, start - days),
      series: buildSignalSeries(selected, previous, days, metric),
    }
  }, [days, filters, metric, sampleSessions])
  const selectedMetric = metrics.find((item) => item.key === metric)!
  const filterCount = Object.values(filters).filter(Boolean).length
  const breakdown = (dimension: SignalDimension) =>
    signalBreakdown(current, dimension)
  const inspect = (dimension: SignalDimension, row: SignalBreakdown) => {
    setExpanded(null)
    setDetail({ dimension, row })
  }
  function exportCsv() {
    const content = [
      [
        "Account",
        "Project",
        "Date (UTC)",
        selectedMetric.label,
        "Previous period",
      ],
      ...series.map((row) => [
        account.name,
        project.name,
        row.date.slice(0, 10),
        row.current,
        row.previous,
      ]),
    ]
      .map((row) => row.join(","))
      .join("\n")
    const url = URL.createObjectURL(
      new Blob([content], { type: "text/csv;charset=utf-8" })
    )
    const link = document.createElement("a")
    link.href = url
    link.download = `forge-signals-${account.id}-${project.id}-sample.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <main
      aria-label="Signals sample dashboard"
      className="min-h-0 min-w-0 flex-1 overflow-y-auto"
    >
      <div className="w-full px-4 pb-6">
        <div className="-mx-4 mb-4 flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border/40 px-3 py-2">
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-muted/65 px-3 py-1.5 text-xs font-normal">
              Overview
            </span>
            <span className="text-[11px] text-muted-foreground">
              Sample data
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className={cn(signalsPill, "text-muted-foreground")}
              onClick={() => setConnectionsOpen(true)}
            >
              <HugeiconsIcon icon={Link01Icon} strokeWidth={1.6} />
              Connections
            </Button>
            <Button
              render={<Link to="/settings/signals" />}
              size="icon-sm"
              variant="ghost"
              aria-label="Configure Signals"
              className="rounded-full text-muted-foreground"
            >
              <HugeiconsIcon icon={Settings02Icon} strokeWidth={1.6} />
            </Button>
          </div>
        </div>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <SignalsAccountScope
            account={account}
            projectId={project.id}
            onSelect={selectScope}
            onManage={() => setConnectionsOpen(true)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="secondary"
                    size="sm"
                    className={controlClass}
                  />
                }
              >
                <HugeiconsIcon
                  icon={FilterHorizontalIcon}
                  strokeWidth={1.6}
                  className="size-3.5"
                />
                Filter{" "}
                {filterCount ? (
                  <span className="flex size-4 items-center justify-center rounded-full bg-foreground text-[10px] text-background">
                    {filterCount}
                  </span>
                ) : null}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Device</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={filters.device ?? "all"}
                    onValueChange={(value) =>
                      setFilters({
                        ...filters,
                        device: value === "all" ? undefined : value,
                      })
                    }
                  >
                    {["All devices", "Desktop", "Mobile", "Tablet"].map(
                      (value, index) => (
                        <DropdownMenuRadioItem
                          key={value}
                          value={index ? value : "all"}
                          className="text-xs"
                        >
                          {value}
                        </DropdownMenuRadioItem>
                      )
                    )}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Plan</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={filters.plan ?? "all"}
                    onValueChange={(value) =>
                      setFilters({
                        ...filters,
                        plan: value === "all" ? undefined : value,
                      })
                    }
                  >
                    {["All plans", "Free", "Pro", "Enterprise"].map(
                      (value, index) => (
                        <DropdownMenuRadioItem
                          key={value}
                          value={index ? value : "all"}
                          className="text-xs"
                        >
                          {value}
                        </DropdownMenuRadioItem>
                      )
                    )}
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="secondary"
              size="sm"
              aria-pressed={compare}
              onClick={() => setCompare(!compare)}
              className={cn(
                controlClass,
                compare && "bg-accent text-foreground"
              )}
            >
              Compare
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="secondary"
                    size="sm"
                    className={controlClass}
                  />
                }
              >
                <HugeiconsIcon
                  icon={Calendar03Icon}
                  strokeWidth={1.6}
                  className="size-3.5"
                />
                Last {days} days <DropdownChevron className="size-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuRadioGroup
                  value={String(days)}
                  onValueChange={(value) => setDays(Number(value))}
                >
                  {[7, 30, 90].map((value) => (
                    <DropdownMenuRadioItem
                      key={value}
                      value={String(value)}
                      className="text-xs"
                    >
                      Last {value} days
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    className="rounded-full border-border/40 bg-muted/55 text-muted-foreground"
                    aria-label="Dashboard actions"
                  />
                }
              >
                <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={1.6} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={exportCsv} className="text-xs">
                  Export chart as CSV
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onExit} className="text-xs">
                  Show empty state
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        {filterCount > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {Object.entries(filters)
              .filter(([, value]) => value)
              .map(([key, value]) => (
                <Button
                  key={key}
                  variant="secondary"
                  size="xs"
                  className="gap-1.5 rounded-full text-xs font-normal"
                  aria-label={`Remove ${key} filter: ${value}`}
                  onClick={() => setFilters({ ...filters, [key]: undefined })}
                >
                  {key === "feature"
                    ? "Sessions using"
                    : key === "plan"
                      ? "Plan"
                      : "Device"}
                  : {value}
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    strokeWidth={1.6}
                    className="size-3"
                  />
                </Button>
              ))}
            <Button
              variant="ghost"
              size="xs"
              className="text-[11px] text-muted-foreground"
              onClick={() => setFilters({})}
            >
              Clear filters
            </Button>
          </div>
        )}

        <section
          aria-label="Usage over time"
          className={cn("overflow-hidden", signalsSurface)}
        >
          <div className="grid grid-cols-2 border-b border-border/30 lg:grid-cols-4">
            {metrics.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={metric === item.key}
                title={item.definition}
                onClick={() => setMetric(item.key)}
                className={cn(
                  "relative min-w-0 border-r border-border/30 px-4 py-4 text-left transition-colors last:border-r-0 hover:bg-muted/20 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring sm:px-5",
                  metric === item.key && "bg-muted/40"
                )}
              >
                <span
                  className={cn(
                    "absolute inset-x-0 top-0 h-0.5",
                    metric === item.key && "bg-primary"
                  )}
                />
                <span className="block text-[11px] text-muted-foreground">
                  {item.label}
                </span>
                <span className="mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className="text-2xl leading-none font-medium tracking-tight tabular-nums">
                    {number.format(totals[item.key])}
                  </span>
                  {compare && (
                    <MetricChange
                      current={totals[item.key]}
                      previous={previousTotals[item.key]}
                    />
                  )}
                </span>
              </button>
            ))}
          </div>
          <div className="px-2 pt-5 pb-3 sm:px-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2 px-3 text-[10px] text-muted-foreground">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-primary" />
                  {dateLabel(signalDate(180 - days))} –{" "}
                  {dateLabel(signalDate(179))}
                </span>
                {compare && (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-3 border-t border-dashed border-muted-foreground/60" />
                    Previous {days} days
                  </span>
                )}
              </div>
              <span>Daily · UTC</span>
            </div>
            <ChartContainer
              config={{
                current: {
                  label: selectedMetric.label,
                  color: "var(--primary)",
                },
                previous: {
                  label: "Previous period",
                  color: "var(--muted-foreground)",
                },
              }}
              className="aspect-auto h-[260px] w-full sm:h-[290px]"
              aria-label={`${selectedMetric.label} over the last ${days} days`}
            >
              <ComposedChart
                data={series}
                margin={{ top: 8, right: 16, bottom: 0, left: 0 }}
                accessibilityLayer
              >
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="var(--primary)"
                      stopOpacity={0.08}
                    />
                    <stop
                      offset="100%"
                      stopColor="var(--primary)"
                      stopOpacity={0.015}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  vertical={false}
                  stroke="var(--border)"
                  strokeOpacity={0.5}
                  strokeDasharray="3 4"
                />
                <XAxis
                  dataKey="date"
                  tickFormatter={dateLabel}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={65}
                  tickMargin={12}
                  fontSize={10}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(value: number) => compact.format(value)}
                  width={42}
                  tickMargin={10}
                  tickCount={5}
                  fontSize={10}
                  allowDecimals={false}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(value) => dateLabel(String(value))}
                    />
                  }
                />
                {compare && (
                  <Line
                    dataKey="previous"
                    type="linear"
                    stroke="var(--muted-foreground)"
                    strokeOpacity={0.5}
                    strokeWidth={1}
                    strokeDasharray="4 4"
                    dot={false}
                    isAnimationActive={false}
                  />
                )}
                <Area
                  dataKey="current"
                  type="linear"
                  stroke="var(--primary)"
                  strokeWidth={1.6}
                  fill={`url(#${gradientId})`}
                  isAnimationActive={false}
                  activeDot={{
                    r: 3.5,
                    stroke: "var(--background)",
                    strokeWidth: 2,
                  }}
                />
              </ComposedChart>
            </ChartContainer>
          </div>
        </section>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {(
            [
              ["features", "pages"],
              ["events", "sources"],
              ["devices", "browsers"],
              ["countries"],
            ] as Array<Array<SignalDimension>>
          ).map((items) => (
            <BreakdownPanel
              key={`${project.id}:${items[0]}`}
              dimensions={items}
              getRows={breakdown}
              onInspect={inspect}
              onExpand={(dimension) => {
                setSearch("")
                setExpanded(dimension)
              }}
            />
          ))}
        </div>
        <p className="mt-5 text-[10px] text-muted-foreground/70">
          {account.name} · {project.name} · Fictional sample data through
          October 26, 2026. No product events are being collected.
        </p>
      </div>

      <SignalsConnectionsDialog
        open={connectionsOpen}
        onOpenChange={setConnectionsOpen}
        accountId={account.id}
        onSelect={selectScope}
      />
      <Dialog
        open={expanded !== null}
        onOpenChange={(open) => {
          if (!open) setExpanded(null)
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {expanded ? dimensions[expanded].title : ""}
            </DialogTitle>
            <DialogDescription>
              {expanded ? dimensions[expanded].definition : ""}
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Search breakdown"
            placeholder="Search…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="max-h-[50vh] overflow-y-auto">
            {expanded && (
              <BreakdownRows
                dimension={expanded}
                rows={breakdown(expanded).filter((row) =>
                  row.name.toLowerCase().includes(search.toLowerCase())
                )}
                onInspect={(row) => inspect(expanded, row)}
              />
            )}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={detail !== null}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="pr-8 break-all">
              {detail?.row.name}
            </DialogTitle>
            <DialogDescription>
              {detail ? dimensions[detail.dimension].definition : ""}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <>
              <div className="grid grid-cols-2 gap-4 rounded-lg border border-border/60 p-4">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {dimensions[detail.dimension].unit}
                  </p>
                  <p className="mt-2 text-2xl font-medium tabular-nums">
                    {number.format(detail.row.count)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {detail.dimension === "features" ? "Adoption" : "Share"}
                  </p>
                  <p className="mt-2 text-2xl font-medium tabular-nums">
                    {detail.row.share.toFixed(1)}%
                  </p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Sample data · {dateLabel(signalDate(180 - days))} –{" "}
                {dateLabel(signalDate(179))}, 2026. Current dashboard filters
                apply.
              </p>
              {(detail.dimension === "features" ||
                detail.dimension === "devices") && (
                <Button
                  size="sm"
                  onClick={() => {
                    setFilters({
                      ...filters,
                      [detail.dimension === "features" ? "feature" : "device"]:
                        detail.row.name,
                    })
                    setDetail(null)
                  }}
                >
                  {detail.dimension === "features"
                    ? "Show sessions using "
                    : "Show sessions on "}
                  {detail.row.name}
                </Button>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </main>
  )
}

function MetricChange({
  current,
  previous,
}: {
  current: number
  previous: number
}) {
  const change = signalChange(current, previous)
  return (
    <span
      title={`Previous period: ${number.format(previous)}`}
      className={cn(
        "rounded px-1 py-0.5 text-[10px] tabular-nums",
        change === null || change === 0
          ? "text-muted-foreground"
          : change > 0
            ? "bg-emerald-500/8 text-emerald-700 dark:text-emerald-400"
            : "bg-red-500/8 text-red-600 dark:text-red-400"
      )}
    >
      {change === null
        ? "No baseline"
        : `${change > 0 ? "↑ " : change < 0 ? "↓ " : ""}${Math.abs(change).toFixed(1)}%`}
    </span>
  )
}

function BreakdownPanel({
  dimensions: items,
  getRows,
  onInspect,
  onExpand,
}: {
  dimensions: Array<SignalDimension>
  getRows: (dimension: SignalDimension) => Array<SignalBreakdown>
  onInspect: (dimension: SignalDimension, row: SignalBreakdown) => void
  onExpand: (dimension: SignalDimension) => void
}) {
  const [active, setActive] = useState(items[0])
  return (
    <section
      aria-label={`${items.map((item) => dimensions[item].title).join(" and ")} breakdown`}
      className={cn("min-w-0 overflow-hidden", signalsSurface)}
    >
      <Tabs
        value={active}
        onValueChange={(next) => setActive(next as SignalDimension)}
        className="gap-0"
      >
        <div className="flex min-h-12 items-center justify-between gap-2 px-3">
          <TabsList
            className="h-7 gap-1 bg-transparent p-0"
            aria-label="Breakdown type"
          >
            {items.map((item) => (
              <TabsTrigger
                key={item}
                value={item}
                className="h-7 rounded-full px-3 text-xs font-normal data-active:bg-muted/65 dark:data-active:bg-muted/65"
              >
                {dimensions[item].title}
              </TabsTrigger>
            ))}
          </TabsList>
          <Button
            size="xs"
            variant="ghost"
            className="rounded-full text-xs font-normal text-muted-foreground"
            aria-label={`View all ${dimensions[active].title.toLowerCase()}`}
            onClick={() => onExpand(active)}
          >
            View all
            <HugeiconsIcon
              icon={ArrowUpRight01Icon}
              strokeWidth={1.5}
              className="size-3"
            />
          </Button>
        </div>
        <TabsContent value={active} className="px-3 pb-3">
          <BreakdownRows
            dimension={active}
            rows={getRows(active).slice(0, 5)}
            onInspect={(row) => onInspect(active, row)}
          />
        </TabsContent>
      </Tabs>
    </section>
  )
}

function BreakdownRows({
  dimension,
  rows,
  onInspect,
}: {
  dimension: SignalDimension
  rows: Array<SignalBreakdown>
  onInspect: (row: SignalBreakdown) => void
}) {
  const max = rows[0]?.count ?? 1
  return (
    <div>
      <div className="mb-1 grid grid-cols-[minmax(0,1fr)_64px_48px] gap-3 px-2 text-[10px] leading-6 text-muted-foreground">
        <span>
          {dimension === "features" ? "Feature" : dimensions[dimension].title}
        </span>
        <span className="text-right">{dimensions[dimension].unit}</span>
        <span className="text-right">
          {dimension === "features" ? "Adoption" : "%"}
        </span>
      </div>
      {rows.map((row) => (
        <button
          key={row.name}
          type="button"
          onClick={() => onInspect(row)}
          className="group grid w-full grid-cols-[minmax(0,1fr)_64px_48px] items-center gap-3 rounded-lg px-2 py-1 text-left text-xs outline-offset-2 hover:bg-muted/35 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <span className="relative min-w-0 overflow-hidden rounded">
            <span
              aria-hidden="true"
              style={{ width: `${(row.count / max) * 100}%` }}
              className="absolute inset-y-0 left-0 rounded-md bg-muted/60 group-hover:bg-muted/90"
            />
            <span
              className={cn(
                "relative block truncate px-2 py-1.5",
                (dimension === "pages" || dimension === "events") &&
                  "font-mono text-[11px]"
              )}
            >
              {row.name}
            </span>
          </span>
          <span className="text-right tabular-nums">
            {number.format(row.count)}
          </span>
          <span className="text-right text-[11px] text-muted-foreground tabular-nums">
            {row.share.toFixed(1)}%
          </span>
        </button>
      ))}
      {rows.length === 0 && (
        <p className="px-2 py-10 text-center text-xs text-muted-foreground">
          No matching data. Try another filter.
        </p>
      )}
    </div>
  )
}
