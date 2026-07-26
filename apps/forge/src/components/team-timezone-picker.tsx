"use client"

import * as React from "react"
import {
  ArrowDown01Icon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

type TimezoneOption = {
  id: string
  label: string
  offsetMinutes: number
}

const timezoneReferenceDate = new Date()

function getTimeZoneName(
  timeZone: string,
  timeZoneName: Intl.DateTimeFormatOptions["timeZoneName"]
) {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    timeZone,
    timeZoneName,
  })
    .formatToParts(timezoneReferenceDate)
    .find((part) => part.type === "timeZoneName")?.value
}

function getTimezoneOffset(timeZone: string) {
  const rawOffset = getTimeZoneName(timeZone, "longOffset") ?? "GMT"
  const normalizedOffset = rawOffset
    .replace("GMT", "")
    .replace(/^([+-])0/, "$1")

  if (!normalizedOffset) {
    return { label: "GMT+0:00", minutes: 0 }
  }

  const [hours = "0", minutes = "0"] = normalizedOffset.split(":")
  const sign = hours.startsWith("-") ? -1 : 1

  return {
    label: `GMT${hours}:${minutes}`,
    minutes: sign * (Math.abs(Number(hours)) * 60 + Number(minutes)),
  }
}

function createTimezoneOption(id: string): TimezoneOption {
  const offset = getTimezoneOffset(id)
  const timezoneName =
    id === "UTC"
      ? "Coordinated Universal Time"
      : (getTimeZoneName(id, "longGeneric") ?? id)
  const city = id.replaceAll("_", " ").split("/").at(-1) ?? id

  return {
    id,
    label: `${offset.label} – ${timezoneName} – ${city}`,
    offsetMinutes: offset.minutes,
  }
}

const timezoneIds = ["UTC", ...Intl.supportedValuesOf("timeZone")]
let cachedTimezoneOptions: Array<TimezoneOption> | undefined
let timezoneOptionsPromise: Promise<Array<TimezoneOption>> | undefined

function scheduleTimezoneWork(callback: (deadline: IdleDeadline) => void) {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(callback, { timeout: 250 })
    return
  }

  window.setTimeout(() => {
    callback({
      didTimeout: true,
      timeRemaining: () => 6,
    })
  }, 0)
}

function loadTimezoneOptions() {
  if (cachedTimezoneOptions) {
    return Promise.resolve(cachedTimezoneOptions)
  }

  if (timezoneOptionsPromise) {
    return timezoneOptionsPromise
  }

  timezoneOptionsPromise = new Promise((resolve) => {
    const options: Array<TimezoneOption> = []
    let index = 0

    function buildChunk(deadline: IdleDeadline) {
      const startedAt = performance.now()

      do {
        options.push(createTimezoneOption(timezoneIds[index]))
        index += 1
      } while (
        index < timezoneIds.length &&
        performance.now() - startedAt < 6 &&
        (deadline.didTimeout || deadline.timeRemaining() > 1)
      )

      if (index < timezoneIds.length) {
        scheduleTimezoneWork(buildChunk)
        return
      }

      cachedTimezoneOptions = options.sort(
        (left, right) =>
          left.offsetMinutes - right.offsetMinutes ||
          left.label.localeCompare(right.label)
      )
      resolve(cachedTimezoneOptions)
    }

    scheduleTimezoneWork(buildChunk)
  })

  return timezoneOptionsPromise
}

export const defaultTeamTimezone =
  timezoneIds.find((id) => id === "Europe/Paris") ?? timezoneIds[0]

export function TeamTimezonePicker({
  onValueChange,
  value,
}: {
  onValueChange: (value: string) => void
  value: string
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [timezoneOptions, setTimezoneOptions] = React.useState(
    cachedTimezoneOptions
  )
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredTimezones = (timezoneOptions ?? []).filter((item) =>
    `${item.label} ${item.id}`.toLocaleLowerCase().includes(normalizedQuery)
  )
  const selectedTimezone = React.useMemo(
    () => createTimezoneOption(value),
    [value]
  )

  React.useEffect(() => {
    let active = true

    void loadTimezoneOptions().then((options) => {
      if (active) setTimezoneOptions(options)
    })

    return () => {
      active = false
    }
  }, [])

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (!nextOpen) setQuery("")
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="group max-w-[390px] rounded-lg font-normal"
          />
        }
      >
        <span className="truncate whitespace-nowrap">
          {selectedTimezone.label}
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className="size-3.5 shrink-0 transition-transform duration-200 ease-out group-data-popup-open:rotate-180 group-data-open:rotate-180"
        />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-max max-w-[calc(100vw-2rem)] min-w-[310px] gap-0 rounded-xl p-0"
      >
        <div className="border-b p-1">
          <div className="relative">
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={2}
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search timezones..."
              aria-label="Search timezones"
              className="h-8 rounded-lg border-0 bg-transparent pl-8 shadow-none focus-visible:ring-0"
            />
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto overscroll-contain">
          <div className="p-1">
            {!timezoneOptions ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                Loading timezones…
              </p>
            ) : filteredTimezones.length > 0 ? (
              filteredTimezones.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    onValueChange(item.id)
                    handleOpenChange(false)
                  }}
                  className="flex min-h-8 w-full items-center justify-between gap-2 rounded-lg px-2 text-left text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="whitespace-nowrap">{item.label}</span>
                  {value === item.id ? (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      strokeWidth={2}
                      className="size-3.5 shrink-0"
                    />
                  ) : null}
                </button>
              ))
            ) : (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                No timezones found
              </p>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
