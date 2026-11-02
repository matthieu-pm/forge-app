// Dedicated Loop workers stop within fifteen minutes. Cleanup waits longer so
// an abandoned reservation cannot race bytes from a still-live upload.
export const LOOP_ARTIFACT_INTENT_LEASE_MS = 20 * 60_000
