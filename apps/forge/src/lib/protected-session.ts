// A browser-only generation fence. Server requests continue to authorize live.
let epoch = 0
const controllers = new Set<AbortController>()
const routeResets = new Set<() => Promise<void>>()
export const protectedSessionEpoch = () => epoch
export function retireProtectedSession() {
  epoch++
  for (const controller of controllers) controller.abort()
  controllers.clear()
}
export function registerProtectedRouteReset(reset: () => Promise<void>) {
  routeResets.add(reset)
  return () => {
    routeResets.delete(reset)
  }
}
export async function resetProtectedRoutes() {
  await Promise.all([...routeResets].map((reset) => reset()))
}
export async function inProtectedSession<T>(
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const token = epoch
  const controller = new AbortController()
  controllers.add(controller)
  try {
    const result = await run(controller.signal)
    if (token !== epoch) throw new Error("The active session changed.")
    return result
  } finally {
    controllers.delete(controller)
  }
}
