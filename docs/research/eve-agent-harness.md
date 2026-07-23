# Vercel eve as Forge's agent harness

Research date: 2026-07-23. This assessment reviews Vercel `eve` 0.27.1 at commit [`f36f143`](https://github.com/vercel/eve/tree/f36f143d88f9a77d5419d641f0bb701f70f06895). Sources are Vercel's official site, documentation, and repository.

## Conclusion

Vercel's **eve** is almost certainly the framework meant here: it is a new, filesystem-first TypeScript framework explicitly positioned as “the framework for building agents,” with durable sessions, typed tools, isolated code execution, approvals, subagents, channels, and evals. That matches Forge's TypeScript stack and its planned agent workspace much more closely than unrelated research projects named EVE. [eve overview](https://eve.dev/), [official repository](https://github.com/vercel/eve).

I would use eve for a Forge prototype **if “the harness uses both tools and code” means**:

- stable Forge capabilities are exposed as typed, permission-checked tools; and
- the model may write and run temporary code in an isolated sandbox for analysis, transformation, and exploration.

That split is natively supported and is the strongest part of the fit. I would not choose eve if the goal is to replace or deeply customize the model/tool control loop: eve owns that loop and exposes capability-level extension points, not a stable custom-harness interface.

## What “tools and code” means in eve

There are three separate mechanisms:

| Mechanism | Supported | Trust boundary | Appropriate use |
|---|---:|---|---|
| Authored tools | Yes, first class | Run in the eve app runtime with full `process.env` access | Forge reads/writes, APIs, durable side effects, operations requiring authorization |
| Agent-written shell/code | Yes, built in | Runs in the agent's isolated sandbox under `/workspace` | Ad hoc analysis, scripts, file transformation, calculations, temporary artifacts |
| Model-authored `Workflow` JavaScript | Experimental | Runs in isolated QuickJS and can call only subagents | Dynamic fan-out/fan-in and programmatic subagent coordination |

Authored tools and sandbox code are deliberately different trust contexts. Eve's tool documentation states that authored tools execute in the app runtime and can access environment variables; its sandbox documentation states that shell and file work executes separately without touching the app runtime. An authored tool can deliberately obtain the current sandbox handle, but this is an explicit bridge rather than shared ambient access. [Tools](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/docs/tools/overview.mdx#L6-L48), [Sandbox](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/docs/sandbox.mdx#L6-L69).

The experimental `Workflow` tool is not a general code tool. Its model-authored JavaScript can orchestrate the root agent's own subagents and remote agents, but cannot access ordinary tools, files, shell, network, skills, connections, imports, environment variables, or the host process. It is root-only and capped at 100 subagent calls by default. [Dynamic Workflows](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/docs/guides/dynamic-workflows.md#L52-L80).

## Harness and control-loop flexibility

Eve calls its built-in agent loop the “default harness.” It manages model calls, context compaction, tool execution, approvals, and durable continuation. Built-in tools include shell/file operations, web access, todos, questions, skills, connections, and delegation; individual defaults can be wrapped, replaced, or disabled. [Default harness](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/docs/concepts/default-harness.md#L6-L104).

The public extension surface is broad—tools, dynamic instructions/capabilities, hooks, channels, connections, state, sandbox backends, subagents, schedules, and instrumentation—but it does not export a replaceable harness or control-loop API. Eve's own API reference says anything outside its documented public exports is internal, and its `defineAgent` configuration is limited to model/runtime settings such as model choice, reasoning, compaction, limits, output schema, and workflow world. [TypeScript API](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/docs/reference/typescript-api.md#L6-L98), [`PublicAgentDefinition`](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/packages/eve/src/shared/agent-definition.ts#L250-L303).

Therefore:

- Custom policies around tools, context, model selection, events, sandboxes, and subagents fit the supported model.
- A custom planner/executor can be expressed as tools or subagents, with experimental `Workflow` for dynamic subagent orchestration.
- Replacing step semantics, stop conditions, tool-result handling, or the inner model-call loop would require relying on internals/forking eve, or using the AI SDK directly instead.

Eve also owns durability: a turn is a workflow, each step is one model call plus its tool calls, and the framework checkpoints at step boundaries. Interrupted steps may rerun, so externally mutating tools must be idempotent or approval-gated. Application code does not author the underlying Workflow SDK primitives directly. [Execution model](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/docs/concepts/execution-model-and-durability.md#L8-L47).

## Fit with the current Forge repository

Forge is currently a Bun-managed TanStack Start/React application with a placeholder `/agent` route, Better Auth, an application-level `Actor`, scope/role authorization, and a small oRPC/OpenAPI surface. Eve is TypeScript/React-friendly, but the integration is not drop-in:

- Eve requires Node 24 or newer and its package declares `node >=24`; Forge currently does not declare that runtime requirement. [Getting started](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/docs/getting-started.mdx#L8-L58).
- Eve has native bundler/server integrations for Next.js, Nuxt, and SvelteKit, **not TanStack Start**. On other stacks, `useEveAgent()` can call same-origin `/eve/v1/*` routes or an explicit host, so TanStack Start can still use the React client with a proxy or separate eve origin. [Frontend integration](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/docs/guides/frontend/overview.mdx#L6-L17).
- Eve can run as its own Nitro/Node service, with separately selected workflow storage and sandbox backend. [Self-hosting](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/docs/guides/deployment/self-hosting.md#L6-L55).

The lowest-risk topology is therefore a small **Node 24 eve service/package beside Forge**, with Forge's `/agent` React UI calling it through a same-origin proxy in production (or an explicit host during the spike). This avoids coupling the main TanStack/Bun runtime to eve's compiler and server lifecycle.

Forge domain operations should be authored tools, not sandbox credentials:

1. Authenticate the incoming eve channel against Forge and translate it into Forge's existing actor identity.
2. Have each tool call Forge application services or the scoped `/api/v1` interface with that actor.
3. Keep database credentials, API keys, and unrestricted service access out of `/workspace`.
4. Use sandbox code only on bounded data intentionally returned by tools.
5. Require approval and idempotency keys for writes or other external side effects.

The existing public API currently covers teams, while the agent product surface anticipates issues, projects, calls, signals, and insights. A useful spike should therefore implement only a thin read-only vertical slice rather than allowing generated code direct database access.

## Recommended spike

Build one read-only agent flow before committing to the framework:

- Run eve as a separate Node 24 service.
- Connect the existing `/agent` route with `useEveAgent({ host })`.
- Add two Forge tools, such as `list_teams` and one narrowly scoped issue/project lookup.
- Leave sandbox `bash` and file tools enabled, but configure deny-all network egress initially.
- Demonstrate a request that uses a Forge tool to fetch structured data, writes a temporary analysis script in the sandbox, runs it, and returns the result.
- Add an eval proving workspace isolation and a negative test proving sandbox code cannot reach Forge secrets or the database.

Proceed if this division feels natural. If the prototype immediately needs custom loop semantics rather than custom capabilities, stop and evaluate a lower-level AI SDK harness instead.

## Main caveats

Eve is currently beta and its APIs and behavior may change before general availability. Its Workflow dependencies are also on a `5.0.0-beta` line. Pin versions and keep the adapter boundary small. [Beta status](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/README.md#L123-L126), [workflow configuration](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/docs/agent-config.md#L170-L216).

Defaults are permissive unless tightened: tool approval is not automatic and sandbox network egress is not deny-all by default. Eve explicitly places responsibility for tool restrictions, route/session authorization, connection scopes, sandbox controls, and approval policy on the deployer. [Responsible use](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/docs/responsible-use.md#L6-L14), [sandbox network policy](https://github.com/vercel/eve/blob/f36f143d88f9a77d5419d641f0bb701f70f06895/docs/sandbox.mdx#L192-L227).
