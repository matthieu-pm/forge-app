import "@tanstack/react-start/server-only"

import { isNotFound, isRedirect } from "@tanstack/react-router"
import { classifyError, emitTelemetry } from "./telemetry.server"

// TanStack catches function middleware errors into `result.error`, then logs
// uncaught exceptions itself. Replace the exception before that serializer/sink.
export function sanitizeServerFunctionError(error: unknown) {
  if (error instanceof Response || isRedirect(error) || isNotFound(error))
    return error
  const code = classifyError(error)
  emitTelemetry("operation.failed", "http", { errorCode: code })
  return Object.assign(new Error("The request could not be completed."), {
    code,
  })
}
