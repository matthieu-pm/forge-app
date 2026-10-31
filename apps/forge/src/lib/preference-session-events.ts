import { retireProtectedSession } from "./protected-session"

type Phase = "start" | "settled"
const listeners = new Set<(phase: Phase) => void>()
export function invalidatePreferenceSession(phase: Phase) {
  retireProtectedSession()
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

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== "forge:session-transition:v1" || !event.newValue) return
    try {
      const message = JSON.parse(event.newValue)
      if (message.phase === "start" || message.phase === "settled") {
        retireProtectedSession()
        for (const listener of listeners) listener(message.phase)
      }
    } catch {
      /* Ignore unrelated or unsupported device events. */
    }
  })
}
export function broadcastSessionInvalidation(phase: Phase) {
  try {
    localStorage.setItem(
      "forge:session-transition:v1",
      JSON.stringify({ phase, nonce: crypto.randomUUID() })
    )
  } catch {
    // Verification on focus is still available when device storage is disabled.
  }
}
