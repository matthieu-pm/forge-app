import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import {
  ECB_REFERENCE_URL,
  ecbRateSnapshotSchema,
} from "./workspace-overage-money"

const MAX_FEED_BYTES = 64 * 1024

/** Fixed-origin read only; no customer, key, price or amount is sent to the ECB. */
export async function fetchEcbReferenceRate(
  fetcher: typeof fetch = fetch,
  clock: () => Date = () => new Date()
) {
  const response = await fetcher(ECB_REFERENCE_URL, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/xml, text/xml" },
  })
  if (!response.ok || !response.body)
    throw new Error("BILLING_FX_SOURCE_UNAVAILABLE")
  const reader = response.body.getReader(),
    chunks: Array<Uint8Array> = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_FEED_BYTES) {
        await reader.cancel()
        throw new Error("BILLING_FX_FEED_INVALID")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  // Parse only the bounded official daily shape. No DTD/entities/XML execution.
  const dates = [
    ...xml.matchAll(
      /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g
    ),
  ]
  const dollars = [
    ...xml.matchAll(
      /<Cube\s+currency=['"]USD['"]\s+rate=['"]([^'"]+)['"]\s*\/>/g
    ),
  ]
  if (
    /<!DOCTYPE|<!ENTITY/i.test(xml) ||
    !xml.includes("http://www.ecb.int/vocabulary/2002-08-01/eurofxref") ||
    dates.length !== 1 ||
    dollars.length !== 1 ||
    !dates[0][2].includes(dollars[0][0]) ||
    !/<\/gesmes:Envelope>\s*$/.test(xml)
  )
    throw new Error("BILLING_FX_FEED_INVALID")
  const observedAt = clock().toISOString(),
    referenceDate = dates[0][1],
    usdPerEur = dollars[0][1]
  const referenceTime = new Date(`${referenceDate}T00:00:00Z`).getTime(),
    observedTime = new Date(observedAt).getTime()
  if (
    !Number.isFinite(referenceTime) ||
    referenceTime > observedTime ||
    observedTime - referenceTime > 7 * 86400000 ||
    Number(usdPerEur) <= 0
  )
    throw new Error("BILLING_FX_RATE_UNAVAILABLE_FOR_USAGE")
  const identity = {
    source: "ecb-daily-reference" as const,
    sourceUrl: ECB_REFERENCE_URL,
    referenceDate,
    observedAt,
    usdPerEur,
  }
  return ecbRateSnapshotSchema.parse({
    ...identity,
    id: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
  })
}
