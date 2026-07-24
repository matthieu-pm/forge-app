# Forge agent platform completion audit

Date: 2026-07-24

Scope: implementation evidence for
`docs/plans/agent-platform-implementation-plan.md`.

## Result

The first production release and the section 19 definition of done are
implemented for the shared web and macOS desktop application. Provider-policy
gates remain intentional: Codex is the supported subscription runtime; other
consumer CLIs are not executed until they have a reviewed embedding surface.
Issue, project, call, signal, review, and insight capabilities remain dependent
on those Forge application modules existing, as required by the plan.

Codex app-server `dynamicTools` is the official local-runtime capability
adapter used by this implementation. It provides the planned MCP boundary
without starting a second credential-bearing process: tool requests are
normalized in Electron, sent through a run-scoped Forge endpoint, and dispatched
by the same capability gateway as EVE tools.

## Definition of done evidence

| Requirement | Implementation and verification |
| --- | --- |
| Composer-only Forge home | `src/components/agent/forge-agent-home.tsx`, `src/routes/forge.tsx`, and the Forge-home case in `src/components/agent/agent-shell.test.tsx` |
| Forge-home chats open maximized over the current page | `src/components/agent/agent-shell.tsx` and the no-navigation overlay tests in `src/components/agent/agent-shell.test.tsx` |
| Ask Forge opens a compact floating chat | `src/components/agent/agent-provider.tsx`, `src/components/agent/agent-chat-panel.tsx`, and shell interaction tests |
| Maximize/minimize does not navigate | Overlay state is owned by `AgentProvider`; the underlying route remains mounted and is made inert only while maximized |
| Bottom tabs and searchable history | `src/components/agent/agent-tabs.tsx`, `src/components/agent/agent-history.tsx`, and tab/history tests |
| Typed streaming for text, tools, code, search, reads, edits, approvals, and artifacts | `src/application/agents/event-contract.ts`, `src/components/agent/agent-transcript.tsx`, `src/adapters/agents/eve-event-normalizer.ts`, and `electron/main/model-broker/adapters/codex-event-normalizer.ts` |
| EVE typed tools and isolated generated code | `services/agent-runtime/agent/tools`, `services/agent-runtime/src/code-runtime.ts`, and the EVE test/eval suites |
| Programmatic JavaScript can call only declared capabilities | `services/agent-runtime/src/program-runtime.ts`; undeclared, divergent replay, call-budget, and write-idempotency tests in `program-runtime.test.ts` |
| Writes are approved, idempotent, and audited | `src/application/agents/approval-service.server.ts`, `capability-gateway.server.ts`, Drizzle approval/idempotency stores, and their tests |
| Manual models and OpenAI-only Auto report runtime, connection, model, effort, and billing | `model-router.ts`, `model-registry.server.ts`, routing events in the coordinator, the ported composer model picker, and router/UI tests |
| API keys stay in a vault; CLI credentials remain provider-owned | `model-secret-vault.server.ts`, model proxy tests, Codex broker/app-server implementation, and credential-redaction tests |
| Codex subscription uses app-server without credential extraction | `electron/main/model-broker/adapters/codex-app-server.ts`, trusted CLI discovery, sanitized process supervision, broker tests, and desktop smoke tests |
| Web and desktop share transcript UI | Electron exposes only the host bridge; both execution planes feed `AgentProvider` and the same canonical renderers |
| Crash/reconnect/resume preserves the thread | Durable EVE cursor handling in `eve-runtime.server.ts` and `agent-coordinator.server.ts`, renderer refresh recovery, and interruption/reconnect tests |
| Workspace isolation, security tests, and eval gates | Actor/run-bound JWTs, scoped stores, SSRF/DNS pinning, endpoint and redaction tests, Electron sender validation, and all EVE release evals |
| EVE remains replaceable | `AgentRuntime` in `runtime-contract.ts`; the coordinator depends on that contract and runtime kind, not EVE internals |

## First milestone evidence

The exact milestone prompt is versioned in
`services/agent-runtime/evals/first-milestone.eval.ts`:

> List my Forge teams, use JavaScript to summarize them by timezone, and
> explain the result.

The eval asserts one `list_teams` call followed by one `run_code` call and
checks the final timezone summary. The surrounding product flow is covered by:

1. centered composer and maximized overlay UI tests;
2. OpenAI-only Auto router tests;
3. `teams.list` capability gateway and token-binding tests;
4. bounded sandbox input and teardown tests;
5. typed EVE tool/code event normalization tests;
6. durable routing and transcript persistence tests;
7. coordinator checkpoint/reconnect tests; and
8. history reopen and renderer-refresh tests.

## Provider coverage

- Forge-managed OpenAI from server environment, OpenAI BYOK, and OpenAI-only
  Auto.
- Anthropic, Gemini, MiniMax, Mistral, xAI, DeepSeek, Kimi Open Platform,
  custom OpenAI-compatible, and custom Anthropic-compatible manual BYOK.
- HTTPS-only custom endpoints with public-address validation, redirect denial,
  DNS pinning, bounded discovery responses, and manual model fallback.
- Local Codex subscription discovery, official login, account/model listing,
  chat, cancellation, approval normalization, Forge dynamic tools, and history.
- Unknown or policy-ineligible consumer CLIs remain blocked by design and do
  not appear as executable model sources.

## Production controls

- UI and server authorization feature flags.
- Provider and capability allowlists.
- User/workspace monthly cost and concurrent-run limits.
- Per-run token and wall-clock limits.
- Artifact and attachment retention sweeps.
- Owner/admin diagnostics with completion, failure, cancellation, approval,
  tool, sandbox, usage, and recovery metrics.
- Prompt/tool payload logging remains absent from diagnostics; canonical
  product events pass through bounded secret redaction.

## Validation record

- Root unit/integration/UI/security suite: 293 tests passing.
- Root TypeScript check: passing.
- Root production build: passing.
- Root lint: zero errors.
- EVE unit suite: 12 tests passing.
- EVE TypeScript check and production build: passing.
- EVE release evals: 18 gates passing across five evals.
- Electron Playwright smoke suite: three tests passing.
- Electron arm64 package: generated and ad-hoc signed successfully.
- `git diff --check`: passing.

The local development stack responds at `http://localhost:3000`; the EVE
endpoint is running at `http://127.0.0.1:2000` and correctly rejects an
unauthenticated info request. An authenticated manual browser walkthrough
requires a Forge login, and an interactive macOS walkthrough requires the
desktop session to be unlocked; automated shared-renderer and Electron tests
cover those flows in this environment.
