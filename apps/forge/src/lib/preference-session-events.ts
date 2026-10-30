type Phase = "start" | "settled"
const listeners = new Set<(phase: Phase) => void>()
export function invalidatePreferenceSession(phase: Phase) {
  for (const listener of listeners) listener(phase)
}
export function onPreferenceSessionInvalidated(
  listener: (phase: Phase) => void
) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
