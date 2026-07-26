import type {
  ThreadModelPreferenceRecord,
  ThreadModelPreferenceStore,
} from "@/application/agents/thread-model-preference"

export class InMemoryThreadModelPreferenceStore
  implements ThreadModelPreferenceStore
{
  readonly records = new Map<string, ThreadModelPreferenceRecord>()

  get(threadId: string) {
    return Promise.resolve(this.records.get(threadId) ?? null)
  }

  upsert(input: ThreadModelPreferenceRecord) {
    this.records.set(input.threadId, input)
    return Promise.resolve(input)
  }
}

