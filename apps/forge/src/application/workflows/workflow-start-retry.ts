const START_DELAYS_MS = [0, 150, 400] as const

export async function runWorkflowStartAttempts(input: {
  beforeAttempt: (attempt: number) => Promise<boolean | void>
  start: () => Promise<void>
  onFailure: (error: unknown, attempt: number) => void
  wait?: (milliseconds: number) => Promise<void>
  random?: () => number
}) {
  const wait =
    input.wait ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const random = input.random ?? Math.random

  for (const [index, baseDelay] of START_DELAYS_MS.entries()) {
    const attempt = index + 1
    if (baseDelay > 0) {
      await wait(baseDelay + Math.floor(random() * 75))
    }
    const shouldStart = await input.beforeAttempt(attempt)
    if (shouldStart === false) return true

    try {
      await input.start()
      return true
    } catch (error) {
      input.onFailure(error, attempt)
    }
  }

  return false
}
