import { defineInstrumentation } from "eve/instrumentation"

export default defineInstrumentation({
  recordInputs: false,
  recordOutputs: false,
  traceChannelRequests: false,
  events: {
    "step.started": ({ session }) => {
      const attributes = session.auth.current?.attributes
      const id = (value: unknown) =>
        typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          value
        )
      return {
        runtimeContext: {
          ...(id(attributes?.runId) ? { runId: attributes!.runId! } : {}),
          ...(id(attributes?.correlationId)
            ? { correlationId: attributes!.correlationId! }
            : {}),
        },
      }
    },
  },
})
