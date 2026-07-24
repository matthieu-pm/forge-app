import type {
  AgentRuntime,
  CancelRuntimeRunContext,
  ResumeRuntimeRunInput,
  RuntimeEvent,
  StartRuntimeRunInput,
} from "@/application/agents/runtime-contract"

export class FakeAgentRuntime implements AgentRuntime {
  readonly kind = "eve" as const
  readonly starts: Array<StartRuntimeRunInput> = []
  readonly resumes: Array<ResumeRuntimeRunInput> = []
  readonly cancelledRuns = new Set<string>()

  constructor(
    private readonly script: (
      input: StartRuntimeRunInput
    ) => ReadonlyArray<RuntimeEvent> = (input) => [
      {
        sourceEventId: `${input.runId}:delta:1`,
        source: "eve",
        type: "assistant.delta",
        payload: { messageId: "assistant-1", delta: "Done" },
      },
      {
        sourceEventId: `${input.runId}:message:1`,
        source: "eve",
        type: "assistant.message",
        payload: { messageId: "assistant-1", content: "Done" },
      },
    ],
    private readonly resumeScript: (
      input: ResumeRuntimeRunInput
    ) => ReadonlyArray<RuntimeEvent> = (input) => [
      {
        sourceEventId: `${input.runId}:resumed:message:1`,
        source: "eve",
        type: "assistant.message",
        payload: { messageId: "assistant-resumed-1", content: "Continued" },
      },
    ]
  ) {}

  async *start(input: StartRuntimeRunInput) {
    await Promise.resolve()
    this.starts.push(input)

    for (const event of this.script(input)) {
      if (this.cancelledRuns.has(input.runId)) return
      yield event
    }
  }

  async *resume(input: ResumeRuntimeRunInput) {
    await Promise.resolve()
    this.resumes.push(input)

    for (const event of this.resumeScript(input)) {
      if (this.cancelledRuns.has(input.runId)) return
      yield event
    }
  }

  cancel(
    runId: string,
    _runtimeSessionId?: string | null,
    _context?: CancelRuntimeRunContext
  ) {
    this.cancelledRuns.add(runId)
    return Promise.resolve()
  }
}
