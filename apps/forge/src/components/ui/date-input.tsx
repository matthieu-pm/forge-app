import * as React from "react"
import { format, isValid, parseISO } from "date-fns"
import { HugeiconsIcon } from "@hugeicons/react"
import { Calendar03Icon } from "@hugeicons/core-free-icons"
import type { Locale } from "react-day-picker"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export type DateInputProps = Omit<
  React.ComponentProps<"input">,
  "type" | "value" | "defaultValue" | "onChange" | "onInput" | "min" | "max"
> & {
  type?: "date" | "datetime-local" | "text"
  value: string
  onValueChange: (value: string) => void
  min?: string
  max?: string
  locale?: Partial<Locale>
  inlineCalendar?: boolean
}

export function DateInput({
  type = "date",
  locale,
  inlineCalendar,
  ...props
}: DateInputProps) {
  if (type === "text") {
    const { value, onValueChange, ...inputProps } = props
    return (
      <Input
        {...inputProps}
        type="text"
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
      />
    )
  }
  return (
    <CalendarInput
      {...props}
      locale={locale}
      inlineCalendar={inlineCalendar}
      withTime={type === "datetime-local"}
    />
  )
}

function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const date = parseISO(`${value}T12:00:00Z`)
  return isValid(date) && date.toISOString().slice(0, 10) === value
    ? date
    : undefined
}

function dateInRange(value: string, min?: string, max?: string) {
  return (
    !value ||
    (!!calendarDate(value) &&
      (!min || value >= min.slice(0, 10)) &&
      (!max || value <= max.slice(0, 10)))
  )
}

function CalendarInput({
  value,
  onValueChange,
  withTime,
  locale,
  inlineCalendar,
  min,
  max,
  disabled,
  readOnly,
  className,
  step,
  ref,
  ...props
}: Omit<DateInputProps, "type"> & { withTime: boolean }) {
  const [open, setOpen] = React.useState(false)
  const [draft, setDraft] = React.useState(() => ({
    source: value,
    date: value.slice(0, 10),
    time: value.slice(11),
    month: calendarDate(value.slice(0, 10)),
  }))
  if (draft.source !== value) {
    const date = value.slice(0, 10)
    setDraft({
      source: value,
      date,
      time: value.slice(11),
      month:
        date !== draft.date ? (calendarDate(date) ?? draft.month) : draft.month,
    })
  }
  const inputRef = React.useRef<HTMLInputElement>(null)
  React.useImperativeHandle(ref, () => inputRef.current!, [])
  React.useEffect(() => {
    const date = draft.date
    inputRef.current?.setCustomValidity(
      dateInRange(date, min, max)
        ? ""
        : "Enter a valid date within the allowed range."
    )
  }, [draft.date, min, max])
  const selected = calendarDate(draft.date)
  const name = props["aria-label"] ?? "Date"
  function validate(input: HTMLInputElement) {
    input.setCustomValidity(
      dateInRange(input.value, min, max)
        ? ""
        : "Enter a valid date within the allowed range."
    )
  }
  function change(date: string, time = draft.time) {
    const next =
      !date || (withTime && !time) ? "" : withTime ? `${date}T${time}` : date
    const valid = dateInRange(date, min, max)
    setDraft({
      source: valid ? next : value,
      date,
      time,
      month:
        valid && date !== draft.date
          ? (calendarDate(date) ?? draft.month)
          : draft.month,
    })
    if (valid) onValueChange(next)
  }
  const calendar = (
    <Calendar
      mode="single"
      selected={selected}
      month={draft.month}
      onMonthChange={(month) => setDraft((current) => ({ ...current, month }))}
      locale={locale}
      timeZone="UTC"
      today={calendarDate(format(new Date(), "yyyy-MM-dd"))}
      disabled={
        disabled || readOnly
          ? true
          : [
              ...(min && calendarDate(min.slice(0, 10))
                ? [{ before: calendarDate(min.slice(0, 10))! }]
                : []),
              ...(max && calendarDate(max.slice(0, 10))
                ? [{ after: calendarDate(max.slice(0, 10))! }]
                : []),
            ]
      }
      onSelect={(date) => {
        if (date) {
          change(
            date.toISOString().slice(0, 10),
            withTime ? draft.time || "00:00" : ""
          )
          setOpen(false)
        }
      }}
    />
  )
  return (
    <span className="inline-flex min-w-0 flex-col gap-2" data-slot="date-input">
      <span className="flex min-w-0 items-center gap-1">
        <Input
          {...props}
          ref={inputRef}
          type="text"
          disabled={disabled}
          readOnly={readOnly}
          className={className}
          placeholder={props.placeholder ?? "YYYY-MM-DD"}
          pattern="[0-9]{4}-[0-9]{2}-[0-9]{2}"
          value={draft.date}
          onChange={(event) => {
            const date = event.target.value
            validate(event.target)
            change(date)
          }}
          onBlur={(event) => {
            validate(event.target)
            props.onBlur?.(event)
          }}
        />
        {!inlineCalendar && (
          <Popover open={open && !disabled && !readOnly} onOpenChange={setOpen}>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled || readOnly}
                  aria-label={`Open calendar for ${name}`}
                />
              }
            >
              <HugeiconsIcon icon={Calendar03Icon} className="size-4" />
            </PopoverTrigger>
            <PopoverContent
              align="start"
              className="w-auto gap-0 p-0"
              aria-label={`${name} calendar`}
            >
              {calendar}
            </PopoverContent>
          </Popover>
        )}
        {withTime && (
          <Input
            type="time"
            aria-label={`${name} time`}
            required={props.required}
            disabled={disabled}
            readOnly={readOnly}
            className={className}
            value={draft.time}
            step={step}
            min={min?.slice(0, 10) === draft.date ? min.slice(11) : undefined}
            max={max?.slice(0, 10) === draft.date ? max.slice(11) : undefined}
            onChange={(event) => change(draft.date, event.target.value)}
          />
        )}
      </span>
      {inlineCalendar && calendar}
    </span>
  )
}
