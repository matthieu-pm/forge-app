const SENSITIVE_KEY =
  /(?:^|[-_])(authorization|cookie|password|secret|token|api[-_]?key|private[-_]?key)(?:$|[-_])/i
const SENSITIVE_VALUE =
  /(?:\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*|\b(?:sk|xai)-(?:proj-|ant-api\d{2}-)?[A-Za-z0-9_-]{12,}\b|\bAIza[A-Za-z0-9_-]{20,}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i

export const MAX_INLINE_AGENT_EVENT_BYTES = 128 * 1024

export class UnsafeAgentEventPayloadError extends Error {
  constructor(
    readonly code: "PAYLOAD_TOO_LARGE" | "SENSITIVE_DATA",
    message: string
  ) {
    super(message)
    this.name = "UnsafeAgentEventPayloadError"
  }
}

function containsSensitiveData(value: unknown, key?: string): boolean {
  if (key && SENSITIVE_KEY.test(key)) return true
  if (typeof value === "string") return SENSITIVE_VALUE.test(value)
  if (Array.isArray(value)) {
    return value.some((item) => containsSensitiveData(item))
  }
  if (value && typeof value === "object") {
    return Object.entries(value).some(([entryKey, entryValue]) =>
      containsSensitiveData(entryValue, entryKey)
    )
  }
  return false
}

export function assertSafeAgentEventPayload(
  payload: Record<string, unknown>
): void {
  const encoded = JSON.stringify(payload)
  if (
    new TextEncoder().encode(encoded).byteLength > MAX_INLINE_AGENT_EVENT_BYTES
  ) {
    throw new UnsafeAgentEventPayloadError(
      "PAYLOAD_TOO_LARGE",
      "Store large tool output as an artifact instead of an inline event."
    )
  }
  if (containsSensitiveData(payload)) {
    throw new UnsafeAgentEventPayloadError(
      "SENSITIVE_DATA",
      "Agent events cannot contain credentials or authentication data."
    )
  }
}
