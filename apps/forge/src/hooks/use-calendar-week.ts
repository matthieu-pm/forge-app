import { usePreferenceGroup } from "@/components/account-preference-provider"

const weekStarts = { sunday: 0, monday: 1, saturday: 6 } as const

export function useCalendarWeek() {
  const { preferences } = usePreferenceGroup("general")
  const weekStartsOn = weekStarts[preferences.firstDayOfWeek]
  return {
    weekStartsOn,
    weekdays: Array.from(
      { length: 7 },
      (_, offset) => (weekStartsOn + offset) % 7
    ),
  }
}
