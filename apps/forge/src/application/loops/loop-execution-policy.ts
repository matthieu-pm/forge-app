/** Leave setup, cancellation and receipt time inside the web function budget. */
export const LOOP_RUN_WALL_CLOCK_MS = 4 * 60_000
export const LOOP_SETTLEMENT_GRACE_MS = 10_000
export const LOOP_CANCEL_SETTLEMENT_MS = 30_000
export const LOOP_RUN_LEASE_MS = 5 * 60_000
export const LOOP_SCHEDULER_SETUP_MS = 20_000
export const LOOP_FUNCTION_DURATION_SECONDS = 300

export function loopSchedulerDriver(
  env: Record<string, string | undefined> = process.env
) {
  const driver = env.FORGE_LOOP_SCHEDULER_DRIVER ?? "vercel"
  if (driver !== "vercel" && driver !== "cloudflare")
    throw new Error("FORGE_LOOP_SCHEDULER_DRIVER must be vercel or cloudflare.")
  return driver
}

/** A stuck runtime cancellation must not hold the scheduler past its budget.
 * The caller records uncertainty; a late result never overwrites that state. */
export async function withinLoopExecutionWindow<T>(
  work: Promise<T>,
  deadlineAt: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("UNCERTAIN_EXECUTION_TIMEOUT")),
          Math.max(0, deadlineAt - Date.now())
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
