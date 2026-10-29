import "@tanstack/react-start/server-only"

import { randomUUID } from "node:crypto"

import type { ZodType } from "zod"

import type { Actor } from "@/application/actor"
import type { ApprovalService } from "@/application/agents/approval-service.server"
import type { CapabilityIdempotencyStore } from "@/application/agents/capability-idempotency-store"
import type {
  CapabilityDescriptor,
  CapabilityInvocation,
  CapabilityResult,
} from "@/application/agents/capability-contract"
import {
  ApprovalError,
  hashApprovalInput,
} from "@/application/agents/approval-service.server"
import {
  observeCommand,
  withCorrelation,
} from "@/application/observability/telemetry.server"

export type CapabilityExecutionContext = {
  runId: string
  abortSignal?: AbortSignal
}

export type CapabilityDefinition<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown,
> = {
  descriptor: CapabilityDescriptor
  inputSchema: ZodType<TInput>
  outputSchema: ZodType<TOutput>
  execute: (
    actor: Actor,
    input: TInput,
    context: CapabilityExecutionContext
  ) => Promise<TOutput>
}

type RegisteredCapability = {
  descriptor: CapabilityDescriptor
  invoke: (
    actor: Actor,
    input: Record<string, unknown>,
    context: CapabilityExecutionContext
  ) => Promise<unknown>
}

export function defineCapability<
  TInput extends Record<string, unknown>,
  TOutput,
>(definition: CapabilityDefinition<TInput, TOutput>): RegisteredCapability {
  return {
    descriptor: definition.descriptor,
    invoke: async (actor, input, context) => {
      const parsedInput = definition.inputSchema.parse(input)
      return definition.outputSchema.parse(
        await definition.execute(actor, parsedInput, context)
      )
    },
  }
}

export class CapabilityRegistry {
  private readonly definitions = new Map<string, RegisteredCapability>()

  constructor(definitions: ReadonlyArray<RegisteredCapability>) {
    for (const definition of definitions) {
      const key = `${definition.descriptor.id}@${definition.descriptor.version}`
      if (this.definitions.has(key)) {
        throw new Error(`Duplicate capability registration: ${key}`)
      }
      this.definitions.set(key, definition)
    }
  }

  get(id: string, version: string) {
    return this.definitions.get(`${id}@${version}`) ?? null
  }

  list() {
    return [...this.definitions.values()].map(
      (definition) => definition.descriptor
    )
  }
}

export class CapabilityGateway {
  readonly #id: () => string
  readonly #now: () => Date

  constructor(
    private readonly registry: CapabilityRegistry,
    private readonly options: {
      approvals?: Pick<ApprovalService, "consume"> &
        Partial<Pick<ApprovalService, "findApprovedForInvocation">>
      transactionalWrite?: (
        actor: Actor,
        invocation: CapabilityInvocation,
        context: CapabilityExecutionContext
      ) => Promise<CapabilityResult>
      idempotency?: CapabilityIdempotencyStore
      id?: () => string
      now?: () => Date
      allowedCapabilities?: ReadonlySet<string> | null
    } = {}
  ) {
    this.#id = options.id ?? randomUUID
    this.#now = options.now ?? (() => new Date())
  }

  descriptors() {
    return this.registry.list()
  }

  async invoke(
    actor: Actor,
    invocation: CapabilityInvocation,
    context: CapabilityExecutionContext
  ): Promise<CapabilityResult> {
    return withCorrelation({ runId: context.runId }, () =>
      observeCommand("capability.invoke", () =>
        this.invokeInternal(actor, invocation, context)
      )
    )
  }

  private async invokeInternal(
    actor: Actor,
    invocation: CapabilityInvocation,
    context: CapabilityExecutionContext
  ): Promise<CapabilityResult> {
    if (
      this.options.allowedCapabilities &&
      !this.options.allowedCapabilities.has(invocation.capabilityId)
    ) {
      return {
        ok: false,
        errorCode: "POLICY_BLOCKED",
        errorMessage: "This capability is disabled by workspace policy.",
      }
    }
    const definition = this.registry.get(
      invocation.capabilityId,
      invocation.capabilityVersion
    )
    if (!definition) {
      return {
        ok: false,
        errorCode: "CAPABILITY_NOT_FOUND",
        errorMessage: "The requested capability or version is unavailable.",
      }
    }

    if (definition.descriptor.risk !== "read" && !invocation.idempotencyKey) {
      return {
        ok: false,
        errorCode: "IDEMPOTENCY_KEY_REQUIRED",
        errorMessage: "Write capabilities require an idempotency key.",
      }
    }

    if (definition.descriptor.risk !== "read") {
      if (this.options.transactionalWrite)
        return this.options.transactionalWrite(actor, invocation, context)
      let approvalId = invocation.approvalId
      if (
        !approvalId &&
        actor.authentication.kind === "agent" &&
        this.options.approvals?.findApprovedForInvocation
      ) {
        const approval = await this.options.approvals.findApprovedForInvocation(
          actor,
          {
            runId: context.runId,
            capabilityId: invocation.capabilityId,
            capabilityVersion: invocation.capabilityVersion,
            capabilityInput: invocation.input,
          }
        )
        approvalId = approval?.id
      }
      if (!approvalId) {
        return {
          ok: false,
          errorCode: "APPROVAL_REQUIRED",
          errorMessage: "This capability requires an approval.",
        }
      }
      return this.invokeWrite(
        actor,
        definition,
        { ...invocation, approvalId },
        context
      )
    }

    return this.execute(definition, actor, invocation, context)
  }

  private async invokeWrite(
    actor: Actor,
    definition: RegisteredCapability,
    invocation: CapabilityInvocation & {
      idempotencyKey?: string
      approvalId?: string
    },
    context: CapabilityExecutionContext
  ): Promise<CapabilityResult> {
    if (
      actor.authentication.kind === "agent" &&
      actor.authentication.runId !== context.runId
    ) {
      return {
        ok: false,
        errorCode: "RUN_BINDING_MISMATCH",
        errorMessage: "The run token does not match this invocation.",
      }
    }
    if (
      !invocation.idempotencyKey ||
      !invocation.approvalId ||
      !this.options.approvals ||
      !this.options.idempotency
    ) {
      return {
        ok: false,
        errorCode: "APPROVAL_UNAVAILABLE",
        errorMessage: "The approval authority is unavailable.",
      }
    }

    const now = this.#now()
    const inputHash = hashApprovalInput(invocation.input)
    const reservation = await this.options.idempotency.reserve({
      id: this.#id(),
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      runId: context.runId,
      approvalId: invocation.approvalId,
      capabilityId: invocation.capabilityId,
      capabilityVersion: invocation.capabilityVersion,
      idempotencyKey: invocation.idempotencyKey,
      inputHash,
      state: "in-progress",
      outcome: null,
      durationMs: null,
      result: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
    })
    if (reservation.kind === "existing") {
      if (reservation.record.inputHash !== inputHash) {
        return {
          ok: false,
          errorCode: "IDEMPOTENCY_KEY_CONFLICT",
          errorMessage:
            "The idempotency key was already used with different input.",
        }
      }
      if (
        reservation.record.state !== "completed" ||
        !reservation.record.result
      ) {
        return {
          ok: false,
          errorCode: "IDEMPOTENCY_IN_PROGRESS",
          errorMessage:
            "A capability invocation with this idempotency key is in progress.",
        }
      }
      return reservation.record.result
    }

    try {
      await this.options.approvals.consume(actor, {
        approvalId: invocation.approvalId,
        runId: context.runId,
        capabilityId: invocation.capabilityId,
        capabilityVersion: invocation.capabilityVersion,
        capabilityInput: invocation.input,
      })
    } catch (error) {
      await this.options.idempotency.release(reservation.record.id)
      return {
        ok: false,
        errorCode:
          error instanceof ApprovalError ? error.code : "APPROVAL_INVALID",
        errorMessage:
          error instanceof ApprovalError
            ? error.message
            : "The approval could not be validated.",
      }
    }

    const executionStartedAt = this.#now()
    const result = await this.execute(definition, actor, invocation, context)
    await this.options.idempotency.complete(
      reservation.record.id,
      result,
      Math.max(0, this.#now().getTime() - executionStartedAt.getTime())
    )
    return result
  }

  private async execute(
    definition: RegisteredCapability,
    actor: Actor,
    invocation: CapabilityInvocation,
    context: CapabilityExecutionContext
  ): Promise<CapabilityResult> {
    try {
      const value = await definition.invoke(actor, invocation.input, context)
      const size = new TextEncoder().encode(JSON.stringify(value)).byteLength
      if (size > definition.descriptor.maxResultBytes) {
        return {
          ok: false,
          errorCode: "CAPABILITY_RESULT_TOO_LARGE",
          errorMessage: "The capability result exceeds its inline size limit.",
        }
      }
      return { ok: true, value }
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        return {
          ok: false,
          errorCode: "INVALID_CAPABILITY_INPUT",
          errorMessage: "The capability input or output is invalid.",
        }
      }
      return {
        ok: false,
        errorCode: "CAPABILITY_EXECUTION_FAILED",
        errorMessage: "The capability execution failed.",
      }
    }
  }
}
