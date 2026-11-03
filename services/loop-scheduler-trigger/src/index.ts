const SCHEDULER_URL = "https://app.forgenow.tech/api/internal/loops"
const REQUEST_TIMEOUT_MS = 290_000
const MAX_RECEIPT_BYTES = 4096

async function readReceipt(
  response: Response,
  kind: "loops" | "sla" = "loops"
) {
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
    if (kind === "sla") {
      if (
        !Number.isSafeInteger(r.dispatched) ||
        (r.dispatched as number) < 0 ||
        (r.dispatched as number) > 100 ||
        !Number.isSafeInteger(r.processed) ||
        (r.processed as number) < 0 ||
        (r.processed as number) > 20 ||
        r.failed !== false
      )
        throw new Error("Invalid SLA scheduler receipt")
      return { dispatched: r.dispatched, processed: r.processed, failed: false }
    }
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
  let status: number | undefined
  let failureStage = "transport"
  try {
    const response = await fetch(SCHEDULER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CRON_SECRET}`,
        "Cache-Control": "no-store",
      },
      // Workers rejects `error` before sending a request. `manual` returns
      // redirects to our non-200 guard without forwarding the credential.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    status = response.status
    failureStage = "http"
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new Error("Scheduler returned a non-success status")
    }
    failureStage = "receipt"
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
        failureStage,
        ...(status === undefined ? {} : { status }),
      })
    )
    throw new Error("Forge scheduler invocation failed")
  }
}

export async function triggerSlaScheduler(env: Env, scheduledTime: number) {
  if (!env.CRON_SECRET || env.CRON_SECRET.length < 32)
    throw new Error("Scheduler secret binding is missing")
  let status: number | undefined
  let failureStage = "transport"
  try {
    const response = await fetch(
      "https://app.forgenow.tech/api/internal/sla-jobs",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${env.CRON_SECRET}`,
          "Cache-Control": "no-store",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      }
    )
    status = response.status
    failureStage = "http"
    if (status !== 200) {
      await response.body?.cancel()
      throw new Error("SLA scheduler returned a non-success status")
    }
    failureStage = "receipt"
    const receipt = await readReceipt(response, "sla")
    console.log(
      JSON.stringify({
        job: "forge.sla.scheduler",
        scheduledTime,
        status,
        ...receipt,
      })
    )
  } catch {
    console.error(
      JSON.stringify({
        job: "forge.sla.scheduler",
        scheduledTime,
        errorCode: "SCHEDULER_REQUEST_FAILED",
        failureStage,
        ...(status === undefined ? {} : { status }),
      })
    )
    throw new Error("Forge SLA scheduler invocation failed")
  }
}

export default {
  fetch() {
    return new Response(null, { status: 404 })
  },
  async scheduled(controller, env) {
    const results = await Promise.allSettled([
      triggerScheduler(env, controller.scheduledTime),
      triggerSlaScheduler(env, controller.scheduledTime),
    ])
    if (results.some((r) => r.status === "rejected"))
      throw new Error("Forge scheduler tick failed")
  },
} satisfies ExportedHandler<Env>
