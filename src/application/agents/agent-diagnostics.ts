export type AgentDiagnosticRun = {
  id: string
  state: string
  executionKind: string
  requestedSelection: Record<string, unknown>
  resolvedModelId: string | null
  reasoningEffort: string | null
  routingReason: string | null
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  costMicros: number
  createdAt: Date
  startedAt: Date | null
  completedAt: Date | null
}

export type AgentDiagnosticEvent = {
  runId: string
  type: string
  payload?: Record<string, unknown>
  occurredAt: Date
}

export type AgentDiagnosticApproval = {
  state: string
}

export type AgentDiagnosticInvocation = {
  outcome: string | null
  durationMs: number | null
}

function increment(record: Record<string, number>, key: string) {
  record[key] = (record[key] ?? 0) + 1
}

function count(record: Record<string, number>, key: string) {
  return Object.hasOwn(record, key) ? record[key] : 0
}

function percentile(values: Array<number>, quantile: number) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  )
  return sorted[index] ?? null
}

function routingDifficulty(reason: string | null) {
  if (!reason) return null
  try {
    const parsed = JSON.parse(reason) as unknown
    if (!parsed || typeof parsed !== "object") return null
    const difficulty = Reflect.get(parsed, "difficulty")
    return typeof difficulty === "string" ? difficulty : null
  } catch {
    return null
  }
}

function ratio(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : numerator / denominator
}

export function summarizeAgentDiagnostics(input: {
  since: Date
  runs: ReadonlyArray<AgentDiagnosticRun>
  events: ReadonlyArray<AgentDiagnosticEvent>
  approvals: ReadonlyArray<AgentDiagnosticApproval>
  invocations: ReadonlyArray<AgentDiagnosticInvocation>
}) {
  const runStates: Record<string, number> = {}
  const executionKinds: Record<string, number> = {}
  const providers: Record<string, number> = {}
  const models: Record<string, number> = {}
  const efforts: Record<string, number> = {}
  const autoDifficulties: Record<string, number> = {}
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let costMicros = 0
  const runDurations: Array<number> = []

  for (const run of input.runs) {
    increment(runStates, run.state)
    increment(executionKinds, run.executionKind)
    const provider = run.requestedSelection.provider
    if (typeof provider === "string") increment(providers, provider)
    if (run.resolvedModelId) increment(models, run.resolvedModelId)
    if (run.reasoningEffort) increment(efforts, run.reasoningEffort)
    if (run.requestedSelection.mode === "auto") {
      const difficulty = routingDifficulty(run.routingReason)
      if (difficulty) increment(autoDifficulties, difficulty)
    }
    inputTokens += run.inputTokens
    outputTokens += run.outputTokens
    cachedInputTokens += run.cachedInputTokens
    costMicros += run.costMicros
    if (run.startedAt && run.completedAt) {
      runDurations.push(run.completedAt.getTime() - run.startedAt.getTime())
    }
  }

  const eventsByRun = new Map<string, Array<AgentDiagnosticEvent>>()
  let reconnects = 0
  const reconnectedRuns = new Set<string>()
  let sandboxStarts = 0
  let sandboxCompletions = 0
  let sandboxFailures = 0
  for (const event of input.events) {
    const events = eventsByRun.get(event.runId) ?? []
    events.push(event)
    eventsByRun.set(event.runId, events)
    if (
      event.type === "progress.note" &&
      event.payload?.state === "reconnecting"
    ) {
      reconnects += 1
      reconnectedRuns.add(event.runId)
    }
    if (event.type === "code.started") sandboxStarts += 1
    if (event.type === "code.completed") sandboxCompletions += 1
    if (
      event.type === "tool.failed" &&
      ["run_code", "execute_program"].includes(String(event.payload?.toolName))
    ) {
      sandboxFailures += 1
    }
  }
  const firstProgress: Array<number> = []
  const firstToken: Array<number> = []
  for (const run of input.runs) {
    const events = eventsByRun.get(run.id) ?? []
    const createdAt =
      events.find((event) => event.type === "run.created")?.occurredAt ??
      run.createdAt
    const progressAt = events.find(
      (event) => event.type === "progress.note"
    )?.occurredAt
    const tokenAt = events.find(
      (event) => event.type === "assistant.delta"
    )?.occurredAt
    if (progressAt) {
      firstProgress.push(progressAt.getTime() - createdAt.getTime())
    }
    if (tokenAt) firstToken.push(tokenAt.getTime() - createdAt.getTime())
  }

  const approvalStates: Record<string, number> = {}
  for (const approval of input.approvals) {
    increment(approvalStates, approval.state)
  }
  const toolDurations = input.invocations.flatMap((invocation) =>
    invocation.durationMs === null ? [] : [invocation.durationMs]
  )
  const toolFailures = input.invocations.filter(
    (invocation) => invocation.outcome === "failed"
  ).length
  const completedRuns = count(runStates, "completed")
  const cancelledRuns = count(runStates, "cancelled")
  const failedRuns = count(runStates, "failed")
  const approved = count(approvalStates, "approved")
  const denied = count(approvalStates, "denied")
  const resolvedApprovals = approved + denied

  return {
    since: input.since.toISOString(),
    generatedAt: new Date().toISOString(),
    runs: {
      total: input.runs.length,
      states: runStates,
      executionKinds,
      durationMs: {
        p50: percentile(runDurations, 0.5),
        p95: percentile(runDurations, 0.95),
      },
      timeToFirstProgressMs: {
        p50: percentile(firstProgress, 0.5),
        p95: percentile(firstProgress, 0.95),
      },
      timeToFirstTokenMs: {
        p50: percentile(firstToken, 0.5),
        p95: percentile(firstToken, 0.95),
      },
      rates: {
        completion: ratio(completedRuns, input.runs.length),
        cancellation: ratio(cancelledRuns, input.runs.length),
        failure: ratio(failedRuns, input.runs.length),
      },
    },
    routing: {
      providers,
      models,
      efforts,
      autoDifficulties,
    },
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      costMicros,
    },
    approvals: {
      states: approvalStates,
      acceptanceRate: ratio(approved, resolvedApprovals),
      denialRate: ratio(denied, resolvedApprovals),
    },
    tools: {
      calls: input.invocations.length,
      failures: toolFailures,
      failureRate: ratio(toolFailures, input.invocations.length),
      latencyMs: {
        p50: percentile(toolDurations, 0.5),
        p95: percentile(toolDurations, 0.95),
      },
    },
    sandbox: {
      starts: sandboxStarts,
      completions: sandboxCompletions,
      failures: sandboxFailures,
      failureRate: ratio(sandboxFailures, sandboxStarts),
    },
    recovery: {
      reconnects,
      reconnectedRuns: reconnectedRuns.size,
    },
  }
}
