const SCHEDULER_URL = "https://app.forgenow.tech/api/internal/loops"
const REQUEST_TIMEOUT_MS = 290_000
const MAX_RECEIPT_BYTES = 4096

async function readReceipt(response: Response) {
  if (!response.body) throw new Error("Missing scheduler receipt")
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let bytes = 0,
    text = "",
    complete = false
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        complete = true
        break
      }
      bytes += next.value.byteLength
      if (bytes > MAX_RECEIPT_BYTES)
        throw new Error("Oversized scheduler receipt")
      text += decoder.decode(next.value, { stream: true })
    }
    const value: unknown = JSON.parse(text + decoder.decode())
    if (!value || typeof value !== "object")
      throw new Error("Invalid scheduler receipt")
    const r = value as Record<string, unknown>
    if (
      typeof r.enabled !== "boolean" ||
      ![r.events, r.scheduled, r.executed].every(
        (v) => Number.isSafeInteger(v) && (v as number) >= 0
      ) ||
      (r.executed as number) > 1
    )
      throw new Error("Invalid scheduler receipt")
    return {
      enabled: r.enabled,
      events: r.events,
      scheduled: r.scheduled,
      executed: r.executed,
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function triggerScheduler(env: Env, scheduledTime: number) {
  if (!env.CRON_SECRET || env.CRON_SECRET.length < 32)
    throw new Error("Scheduler secret binding is missing")
  try {
    const response = await fetch(SCHEDULER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
        "Cache-Control": "no-store",
      },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new Error("Scheduler returned a non-success status")
    }
    const receipt = await readReceipt(response)
    console.log(
      JSON.stringify({
        job: "forge.loops.scheduler",
        scheduledTime,
        status: 200,
        ...receipt,
      })
    )
  } catch {
    // Never log request headers, bodies or transport exception text.
    console.error(
      JSON.stringify({
        job: "forge.loops.scheduler",
        scheduledTime,
        errorCode: "SCHEDULER_REQUEST_FAILED",
      })
    )
    throw new Error("Forge scheduler invocation failed")
  }
}

export default {
  fetch() {
    return new Response(null, { status: 404 })
  },
  async scheduled(controller, env) {
    await triggerScheduler(env, controller.scheduledTime)
  },
} satisfies ExportedHandler<Env>
