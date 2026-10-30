import "@tanstack/react-start/server-only"
import { createHash } from "node:crypto"
import { EnvelopeModelSecretVault } from "../agents/model-secret-vault.server"

export type CredentialClient = {
  query: (
    sql: string,
    values?: Array<unknown>
  ) => Promise<{ rows: Array<Record<string, any>> }>
}
export async function readCredentialCoverage(client: CredentialClient) {
  const model = (
    await client.query(
      "SELECT id,workspace_id,secret_reference FROM public.model_connections WHERE secret_reference IS NOT NULL ORDER BY id"
    )
  ).rows
  const meeting = (
    await client.query(
      "SELECT id,workspace_id,secret FROM public.call_connections WHERE secret IS NOT NULL ORDER BY id"
    )
  ).rows
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ model, meeting }))
    .digest("hex")
  return {
    model,
    meeting,
    fingerprint,
    counts: { model: model.length, meeting: meeting.length },
  }
}
export async function verifyCredentialCoverage(
  client: CredentialClient,
  key: string
) {
  const coverage = await readCredentialCoverage(client),
    vault = new EnvelopeModelSecretVault(key),
    failures: Array<string> = []
  for (const row of coverage.model)
    try {
      await vault.open(row.secret_reference, `${row.workspace_id}:${row.id}`)
    } catch {
      failures.push(`model_connections:${row.id}`)
    }
  for (const row of coverage.meeting)
    try {
      await vault.open(row.secret, `meeting:${row.workspace_id}:${row.id}`)
    } catch {
      failures.push(`call_connections:${row.id}`)
    }
  if (failures.length)
    throw new Error(`RECOVERY_CREDENTIALS_UNREADABLE:${failures.join(",")}`)
  return coverage
}
