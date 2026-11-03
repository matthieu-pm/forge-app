# Calendar week start (FOR-129)

The account's `general.firstDayOfWeek` selects Sunday (0), Monday (1), or
Saturday (6). `useCalendarWeek` reads the authenticated FOR-127 subscription.
Every Forge calendar consumes that subscription, including already-open pickers.
No legacy local preference key is read. If account preferences are unavailable,
the shared contract's Sunday default applies; editing the preference still
requires the existing personal-preference sync gate.

## Presentation and navigation

The shared `Calendar` passes the selected start to React Day Picker. Its weekday
columns, leading/trailing month days, Home (start of week), End (end of week),
and Arrow Up/Down (seven days) use the same presentation. Navigation can cross
month and year boundaries. It never selects a date or invokes a data writer.
Stable custom components and the attached day-button focus ref retain functional
keyboard navigation.

Week numbers are hidden. The personal preference does not redefine ISO 8601:
ISO weeks still start Monday, week 1 contains January 4, and ISO weekday values
remain Monday=1 through Sunday=7. No application week-number display or
week-number persistence was present in the inventory. Day Picker's internal row
numbers are not application week identifiers. ISO/broadcast calendar modes and
week-number display cannot override the personal column order in this wrapper.

## Date values, locale and timezones

`DateInput` replaces native browser date popups, whose column order cannot be
controlled by Forge. It offers manual `YYYY-MM-DD` entry and the shared calendar;
datetime controls retain a native time field, including existing seconds.
Only complete, valid dates inside any supplied bounds are emitted. Incomplete
manual input remains a local draft and participates in form validation. Clearing
is supported, as are required, disabled and read-only fields. The milestone
picker keeps its existing inline calendar layout.

Date strings are civil dates. The date-only calendar uses UTC at noon to avoid
host-timezone conversions; choosing a day emits that same `YYYY-MM-DD`. This is
presentation arithmetic, not a change to a schedule's timezone. A datetime
selection replaces only its date portion, preserving the time suffix. A new
datetime with no time defaults to 00:00 only after an explicit calendar choice.
Time-only drafts are retained until a date is supplied. Existing schedule
conversion and daylight-saving validation remain in their existing callers.

`Calendar` preserves its caller's locale, formatters, selected value and timezone.
For example a French calendar in Pacific/Auckland keeps its French captions and
selected instant while changing the first column. Preference updates call no
selection callback, due-date writer, cycle generator or scheduling executor.

## Inventory

| Surface | Integration |
| --- | --- |
| Project milestone target dates, overview and action dialog | Inline `DateInput` |
| Issue composer due date | `DateInput` |
| Triage issue composer due date | `DateInput` |
| Sub-issue composer due date | `DateInput` |
| Initiative target/start day precision | `DateInput`; month/quarter/year precision unchanged |
| Initiative date filter conditions | `DateInput`; non-date filter values remain text |
| Team directory created-date filters | `DateInput`; non-date filter values remain text |
| Recurring issue first due date | `DateInput`; cadence and team timezone unchanged |
| Inbox custom snooze | Datetime `DateInput`; timestamp conversion unchanged |
| Imported call date | Datetime `DateInput`; existing conversion unchanged |
| Loop first scheduled run | Datetime `DateInput`; IANA-zone/DST conversion unchanged |
| Loop weekly weekdays | Presentation reordered; stored ISO weekday values unchanged |
| Team cycle start weekday | Options reordered; stored Sunday=0 weekday and existing cycle dates unchanged |
| Team cycle lists | Date labels/list navigation only; no month/week grid or week-number display |

This inventory covers the application sources. All application date/datetime
calendar controls now use the shared abstraction. Existing feature gates for
cycles, loops, calls, and canonical/shared data remain authoritative. This change
adds no migration and enables no new server capability.

## Acceptance

- AT-01 / AC-01: `components/ui/calendar.test.tsx` renders all three starts at
  January 1, March 1, and leap day, checks the first header and date column,
  and drives Home, End, Arrow Down, and Arrow Up without selecting a date.
- AT-02 / AC-02: the same suite refreshes a mounted French/Auckland calendar
  through the real preference client, retaining selection, timezone, locale, and
  calendar root. Another account's edit has no effect.
- `components/preferences-settings.test.tsx` changes the real First day of the
  week selector while a separate picker stays mounted.
- `components/ui/date-input.test.tsx` verifies manual entry, validation, clearing,
  read-only/disabled/required fields, live preference changes, preserved seconds,
  and replacing only the selected civil date.
- `components/calendar-scheduling.test.tsx` verifies weekday presentation changes
  without changing the first-run instant, IANA timezone, selected weekdays or
  emitting a schedule update; explicitly choosing Saturday still emits ISO 6.

Run from `apps/forge`:

```sh
bunx vitest run src/components/ui/calendar.test.tsx src/components/ui/date-input.test.tsx src/components/calendar-scheduling.test.tsx src/components/preferences-settings.test.tsx src/components/account-preference-provider.test.tsx src/components/team-cycles-settings.test.tsx src/components/recurring-issues/recurring-issue-editor.test.tsx src/components/issues/issue-composer-assignment.test.tsx src/lib/cycle-calendar.test.ts src/lib/loop-matching.test.ts
```

The focused calendar/date/scheduling suites are also exercised under
`TZ=America/Los_Angeles` and `TZ=Pacific/Auckland`. Browser fixture checks use the
real components, Preferences screen and preference client with an in-memory
persistence adapter. They establish renderer behavior, not authenticated hosted
persistence or a production release. FOR-127 owns authenticated preference
persistence and its cross-session refresh cadence. Hosted and packaged-desktop
acceptance are not claimed by this change.
