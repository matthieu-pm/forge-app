export function createTimedRequestCache<T>(
  load: () => Promise<T>,
  ttlMs: number,
  now: () => number = () => Date.now()
) {
  let cached: { expiresAt: number; request: Promise<T> } | undefined

  function loadCached() {
    const currentTime = now()
    if (cached && currentTime < cached.expiresAt) {
      return cached.request
    }

    const request = load().catch((error) => {
      if (cached?.request === request) cached = undefined
      throw error
    })
    cached = { expiresAt: currentTime + ttlMs, request }
    return request
  }

  return Object.assign(loadCached, {
    clear: () => {
      cached = undefined
    },
  })
}
