# Forge model providers, subscriptions, and Auto routing

Research date: 2026-07-23. Sources are first-party documentation, repositories, help centers, and terms. This is a product and technical assessment, not legal advice.

## Conclusion

Forge can offer one model selector, but it needs **two different execution planes**:

1. **Native Forge providers** use an API key or provider-issued API credential. The selected model runs inside Forge's own agent loop, so Forge owns tools, generated JavaScript, approvals, persistence, and event rendering.
2. **External agent runtimes** run an installed first-party CLI or SDK locally. Codex, Claude Code, Gemini CLI, and Kimi Code each bring their own agent loop and authentication. Forge can wrap their streams and expose Forge capabilities through MCP or another supported extension surface, but it does not receive a reusable raw model credential.

Treating a consumer CLI login as a generic inference token would be technically unsafe and, for several providers, contrary to their published terms. Forge must never read browser cookies, copy CLI OAuth tokens, import credential files, or call private subscription backends directly.

The viable first release is:

- **Auto** plus manual OpenAI models through either an OpenAI API key or a local Codex app-server.
- Direct BYOK adapters for OpenAI, Anthropic, Google Gemini, xAI, Mistral, DeepSeek, MiniMax, and compatible custom endpoints.
- Local subscription adapters only where the provider publishes an embedding or programmatic surface, initially Codex app-server and then Claude Agent SDK.
- Gemini and Kimi subscription bridges behind a provider/legal validation gate despite their technical integration surfaces.
- No consumer-subscription bridge for Grok/xAI, Mistral Le Chat, or DeepSeek Chat.

## The architectural boundary

```text
                                  ┌─────────────────────────────┐
                                  │ Forge model selector        │
                                  │ Auto + models + connections │
                                  └──────────────┬──────────────┘
                                                 │
                         ┌───────────────────────┴───────────────────────┐
                         │                                               │
               Native Forge provider                          External agent runtime
               API key / API identity                         local CLI / official SDK
                         │                                               │
               Forge agent loop                              provider-owned agent loop
               Forge Code Mode                               provider tools and code
               Forge approvals                               normalized by an adapter
               Forge tool gateway                            Forge tools exposed via MCP
```

This is not merely an implementation detail. A direct API model can execute model-authored JavaScript that calls all Forge capabilities through the planned `CapabilityGateway`. A CLI subscription normally cannot be inserted into that same inference call. Its official process owns model requests, context, tool calls, and often session storage.

The selector can visually unify both kinds of connection, but every model identity must retain its execution source:

```ts
type ModelRef = {
  connectionId: string
  executionKind: "forge-native" | "external-agent"
  provider: string
  modelId: string
}
```

For example, `codex-chatgpt:gpt-5.6-sol` and `openai-api:gpt-5.6-sol` are different choices even when the display name is the same.

## Provider support matrix

| Provider/source | Authentication | Model discovery | Execution path | Recommendation |
|---|---|---|---|---|
| OpenAI API | User API key | `GET /v1/models`, intersected with Forge capability metadata | Forge-native | Ship first |
| Codex subscription | ChatGPT OAuth owned by Codex | app-server `model/list` | Local Codex app-server | Ship first as local-only |
| Anthropic API | User API key or workload identity | `GET /v1/models`, including capability metadata | Forge-native | Ship early |
| Claude subscription | Claude OAuth owned by Claude Code | CLI aliases/configuration; do not reuse the token with the API | Claude Agent SDK or `claude -p` | Local beta after terms review |
| Gemini API | Gemini API key / Vertex identity | Gemini `models.list` | Forge-native | Ship early |
| Gemini subscription | Google OAuth owned by Gemini CLI | CLI model picker/aliases | Local Gemini CLI headless mode | Do not ship without written clarification |
| Kimi Open Platform | User API key | OpenAI-compatible catalog when supported; otherwise provider catalog | Forge-native | Ship after adapter validation |
| Kimi membership | Kimi Code OAuth or membership key | Kimi Code models/tiers | Kimi Agent SDK / Kimi Code | Personal local beta only after provider approval |
| MiniMax | Pay-as-you-go key or Token Plan key | `GET /v1/models` | Forge-native | Ship as BYOK; Token Plan key is already subscription-backed |
| xAI | User API key | `GET /v1/models` or `/v1/language-models` | Forge-native | Ship as BYOK only |
| Mistral | User API key | `GET /v1/models` | Forge-native | Ship as BYOK only |
| DeepSeek | User API key | `GET /models` | Forge-native | Ship as BYOK only |
| Custom compatible | User key plus base URL | `GET /v1/models`, then manual model entry fallback | Forge-native when protocol-compatible | Ship later with a trust warning |

## OpenAI Auto mode

The user's requirement that Auto use **only OpenAI models** is a good product boundary. Auto must never silently fall back to Anthropic, Gemini, or another provider.

### Candidate models

OpenAI currently positions:

- `gpt-5.6-luna` for clear, repeatable, latency- or cost-sensitive work.
- `gpt-5.6-terra` as the everyday balance of intelligence and cost.
- `gpt-5.6-sol` for ambiguous, complex, open-ended, or high-value tasks.

Reasoning effort is a separate choice from the model. OpenAI documents `none`, `low`, `medium`, `high`, `xhigh`, and `max` for the GPT-5.6 family. [OpenAI models](https://developers.openai.com/api/docs/models), [model guidance](https://developers.openai.com/api/docs/guides/latest-model).

### Routing policy

Auto should use a versioned Forge policy, not an unrestricted model judgment:

| Difficulty | Typical signals | Initial route |
|---|---|---|
| Simple | narrow question, extraction, formatting, one bounded read, explicit expected output | Luna with low or no reasoning |
| Standard | several reads/tools, normal implementation, bounded debugging, routine analysis | Terra with medium reasoning |
| Complex | ambiguity, broad codebase impact, multiple systems, difficult diagnosis, architecture or high-value synthesis | Sol with high reasoning |
| Exceptional | failed high-quality attempt, explicit depth request, hardest review/research | Sol with `xhigh`; reserve `max` for an explicit policy or measured retry |

Routing must be based on observable request characteristics: estimated scope, number of referenced resources, whether the task is diagnostic or generative, expected tool breadth, ambiguity, and prior failed attempts. Risk is a separate dimension: selecting a stronger model never reduces approval, authorization, or sandbox requirements.

At run start, Forge should persist and display:

```ts
{
  requestedSelection: "auto",
  resolvedConnectionId: "…",
  resolvedModelId: "gpt-5.6-terra",
  reasoningEffort: "medium",
  routingPolicyVersion: "openai-auto-v1",
  routingReason: "multi-step implementation with bounded file scope"
}
```

Do not change model or billing source invisibly in the middle of a thread. A retry or escalation may choose a stronger model, but the UI should announce it. If both Codex subscription and an OpenAI API key are connected, the user chooses a preferred OpenAI billing source. If no healthy OpenAI connection exists, disable Auto and show **Connect OpenAI or Codex**.

### Discovery

For an API key, `GET /v1/models` returns the models available to that credential, but only basic identity/ownership data. Forge therefore needs a signed, versioned capability catalog and should intersect it with the API result rather than infer tool support from names. [OpenAI Models API reference](https://platform.openai.com/docs/api-reference/models/object).

For a ChatGPT/Codex subscription, use Codex app-server's `model/list`. It returns the catalog visible to that signed-in account, including picker metadata and supported reasoning efforts. Do not assume the API-key and subscription catalogs are identical. [Codex app-server model discovery](https://learn.chatgpt.com/docs/app-server#list-models-model-list).

## OpenAI and Codex subscription

Codex officially supports ChatGPT sign-in for subscription access and API-key sign-in for usage-based access. The two credentials are not interchangeable: an API key uses Platform billing, while ChatGPT sign-in follows the user's ChatGPT workspace and Codex entitlements. [Codex authentication](https://learn.chatgpt.com/docs/auth).

`codex app-server` is the strongest subscription integration in this research. OpenAI explicitly describes it as the interface for embedding Codex in a product with authentication, conversation history, approvals, and streamed events. It speaks JSON-RPC over local JSONL/stdio or other transports and exposes account login/read and model-list operations. [Codex app-server](https://developers.openai.com/codex/app-server).

Forge should:

- start the user's installed Codex app-server as a child process over stdio or a local Unix socket;
- let Codex conduct browser/device OAuth and refresh its own credentials;
- use `account/read` for connection state and `model/list` for the model selector;
- normalize thread, turn, item, approval, and delta events into Forge's UI event schema;
- keep the adapter local-only; and
- prefer Codex's OS-keyring credential store.

Forge must not read, upload, synchronize, or parse `~/.codex/auth.json`. OpenAI warns that cached auth data is password-equivalent, while app-server already provides the supported integration boundary. Consumer terms also prohibit sharing account credentials or making an account available to others. [Codex credential storage](https://learn.chatgpt.com/docs/auth#credential-storage), [OpenAI EU Terms of Use](https://openai.com/policies/eu-terms-of-use/).

Codex subscription models execute inside the Codex harness. Forge can provide product capabilities through supported tool/MCP integration, but this is not the same runtime as Forge-native Code Mode.

## Anthropic API and Claude subscription

The Claude API has a strong discovery endpoint: `GET /v1/models` returns models available to the API credential and includes model display names, token limits, and capability flags such as image/PDF input, code execution, structured output, thinking, and supported effort levels. [Claude Models API](https://platform.claude.com/docs/en/api/models/list).

Claude Code supports:

- a Claude Pro or Max subscription through the user's Claude account;
- Anthropic Console/API billing;
- non-interactive `claude -p`;
- `json` and `stream-json` output;
- a `--model` flag using documented aliases or full names; and
- the Claude Agent SDK for embedding the agent runtime in custom applications.

[Claude Code setup](https://code.claude.com/docs/en/setup), [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference), [model configuration](https://code.claude.com/docs/en/model-config).

The model configuration page publishes aliases including `default`, `best`, `sonnet`, `opus`, `haiku`, long-context variants, and `opusplan`. Account tier and organization policy can affect what is actually available, so Forge should present only the aliases/configuration reported or accepted by the installed CLI and handle a rejected model as a connection refresh—not read OAuth credentials and call `/v1/models` itself.

Anthropic's current policy is unusually time-sensitive:

- Its general login guidance says developers building products for others should prefer API-key authentication and must not misrepresent identity or route third-party traffic against subscription limits.
- A June 16, 2026 help-center update says a planned change was paused and that, for now, Claude Agent SDK, `claude -p`, and third-party app usage still draw from subscription usage.

[Claude account authentication guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), [Claude Agent SDK with a Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

That supports a local Claude Agent SDK adapter technically, but the policy is explicitly evolving. Ship it as a local beta only after product/legal review, identify Forge truthfully as the client, never pool usage, and retain an API-key path as the stable commercial option. Also sanitize child-process environments: Claude Code gives `ANTHROPIC_API_KEY` precedence over subscription login, which can cause unexpected API billing. [Anthropic credential precedence](https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code).

## Google Gemini

For API-key connections, Gemini has a proper `models.list` endpoint with model IDs, display names, supported actions, and input/output limits. This is appropriate for a Forge-native provider. [Gemini Models API](https://ai.google.dev/api/models).

Gemini CLI supports Google OAuth, Google AI Pro/Ultra and Code Assist entitlements, manual or Auto model selection, and a documented headless interface. `--output-format stream-json` emits initialization, message, tool-use, tool-result, error, and result events. [Gemini CLI plans](https://geminicli.com/plans/), [model selection](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/model.md), [headless mode](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md).

However, Google's official Gemini CLI terms and FAQ say that third-party software must not harvest or piggyback on Gemini CLI OAuth to access the service backend, and direct third-party access using CLI OAuth may lead to suspension. They recommend AI Studio or Vertex API credentials for third-party coding agents. [Gemini CLI terms and privacy](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/tos-privacy.md), [Gemini CLI FAQ](https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/faq.md).

The CLI simultaneously documents headless mode as a programmatic interface, so local scripting is intended, but the published terms do not clearly bless distributing a third-party desktop UI that uses consumer OAuth by spawning it. Do not launch a Gemini-subscription adapter commercially until Google confirms this exact architecture. BYOK through the Gemini API or Vertex is the supported default.

## Kimi

Moonshot publishes both an official Kimi Code CLI and a Kimi Agent SDK. The SDK explicitly exists to expose Kimi Code in applications, stream responses and tool calls, handle approvals, and reuse the CLI's configuration and credentials. [Kimi Agent SDK](https://github.com/MoonshotAI/kimi-agent-sdk), [Kimi Code](https://github.com/MoonshotAI/kimi-code).

That makes a local adapter technically feasible, and Kimi Code exposes Standard and HighSpeed model tiers. [Kimi membership guide](https://www.kimi.com/help/kimi-code/membership-guide).

The subscription terms are narrower than the SDK license:

- Kimi says membership benefits are for personal development rather than enterprise use.
- Its community guidelines describe subscriptions as personal, interactive use and prohibit reselling capabilities or non-interactive automation.
- The help center warns that tools outside its supported list may be treated as misuse.

[Kimi Code benefits](https://www.kimi.com/help/kimi-code/benefits), [Kimi Code community guidelines](https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html).

Therefore, an open-source SDK license is not sufficient permission to market Kimi membership as a general Forge backend. Use Kimi's Open Platform API key for the normal provider adapter. A local subscription adapter should wait for Moonshot approval or a published Forge-compatible policy.

## MiniMax

MiniMax is the cleanest example of a subscription exposed as a supported API credential. A Token Plan issues its own API key, is intended for third-party AI tools, and works through compatible APIs. Forge can treat it as a normal BYOK connection while labeling its billing mode `token-plan` rather than `pay-as-you-go`. [MiniMax Token Plan](https://platform.minimax.io/docs/token-plan/intro).

MiniMax exposes both OpenAI-compatible and Anthropic-compatible model-list endpoints. `GET https://api.minimax.io/v1/models` is sufficient for the initial text-model selector. [MiniMax OpenAI-compatible List Models](https://platform.minimax.io/docs/api-reference/models/openai/list-models), [Anthropic-compatible List Models](https://platform.minimax.io/docs/api-reference/models/anthropic/list-models).

Its official `mmx` CLI also uses the Token Plan API key rather than a private consumer OAuth token, so using the direct API is simpler for the Forge harness. [MiniMax CLI](https://platform.minimax.io/docs/token-plan/minimax-cli).

## xAI / Grok

xAI offers an authenticated `GET /v1/models` endpoint and richer language-model listing endpoints that reflect the models available to an API key. This is suitable for BYOK. [xAI Models API](https://docs.x.ai/developers/rest-api-reference/inference/models).

There is no first-party Grok coding CLI/subscription embedding surface identified in the official xAI repositories or documentation. More importantly, xAI's consumer Acceptable Use Policy prohibits automated/non-human access and bot access to its consumer service. The enterprise terms separately authorize API integrations. [xAI Consumer Terms](https://x.ai/legal/terms-of-service), [xAI Acceptable Use Policy](https://x.ai/legal/acceptable-use-policy), [xAI Enterprise Terms](https://x.ai/legal/terms-of-service-enterprise).

Forge should support xAI only through an xAI API key. It must not reuse Grok.com, SuperGrok, or X subscription credentials.

## Mistral

Mistral's API provides `GET /v1/models` for the models available to the user. [Mistral Models API](https://docs.mistral.ai/api/endpoint/models).

Mistral Vibe is an official open-source coding CLI, but its documented authentication is a Mistral API key stored in its environment/configuration—not a Le Chat consumer-subscription OAuth entitlement. [Mistral Vibe](https://github.com/mistralai/mistral-vibe).

Forge should use the direct Mistral API adapter. Wrapping Vibe would replace Forge's harness without adding a new supported billing source.

## DeepSeek

DeepSeek's official API requires a bearer API key and exposes `GET /models` for current model IDs. Its integration guides recommend compatible third-party agents through BYOK. [DeepSeek API](https://api-docs.deepseek.com/api/deepseek-api), [DeepSeek List Models](https://api-docs.deepseek.com/api/list-models).

No official DeepSeek consumer-subscription CLI/OAuth surface was found. Projects described as DeepSeek CLIs in the ecosystem are third-party clients using an API key. Forge should support DeepSeek only as BYOK.

## Model selector and connection UX

The selector should put the execution and billing source in view:

```text
Auto
  Auto · OpenAI                         OpenAI only

OpenAI
  GPT-5.6 Sol                           via Codex · ChatGPT Pro
  GPT-5.6 Terra                         via Codex · ChatGPT Pro
  GPT-5.6 Sol                           via OpenAI API · PAYG

Anthropic
  Claude Opus                           via Claude Code · Max · Local beta
  Claude Sonnet 4.6                     via Anthropic API · PAYG

Other providers
  Gemini …
  Kimi …
  MiniMax …
```

Each connection needs health, locality, billing mode, last discovery time, and provider-policy status. Duplicate model names must remain separate rows or use a source submenu; silently choosing a credential can cause unexpected charges.

Recommended connection records:

```ts
type ProviderConnection = {
  id: string
  provider: string
  kind: "api-key" | "workload-identity" | "local-agent"
  locality: "local-only" | "server-capable"
  billingMode: "subscription" | "token-plan" | "pay-as-you-go"
  credentialOwner: "forge-local-vault" | "forge-server-vault" | "provider-process"
  status: "ready" | "login-required" | "expired" | "unavailable" | "policy-blocked"
  discoveredAt: string | null
}
```

The database stores only secret references and non-secret metadata. A provider-process connection stores no OAuth token in Forge.

## Security requirements

### API keys

- Store desktop keys in the operating-system credential vault; never local storage, plaintext settings, analytics, logs, or thread data.
- For server execution, encrypt keys with a managed KMS and per-user/per-workspace access controls; do not send locally scoped keys to Forge servers without a separate, explicit user decision.
- Show the provider, masked suffix, scopes when available, and billing mode before the first run.
- Refresh model catalogs with a bounded read-only request and redact provider errors.
- Treat custom base URLs as privileged configuration: require HTTPS except explicit localhost mode, constrain redirects, protect against SSRF, and clearly show that prompts and keys go to that host.

### Local CLI and SDK adapters

- Detect executables and versions without reading credential files.
- Launch a resolved executable path directly, never through a shell command string.
- Use stdio or a local Unix socket; do not expose an unauthenticated network listener.
- Give the child process a minimal environment. In particular, prevent unrelated provider API keys from overriding subscription authentication.
- Scope the working directory and inherited filesystem access to the user's chosen workspace.
- Apply timeouts, output limits, process-tree cancellation, version compatibility checks, and restart/reconnect logic.
- Normalize provider approvals; never auto-enable YOLO/dangerous permission modes.
- Never upload, sync, log, or back up CLI OAuth state.
- Make the user complete login in the provider's official flow and show which local process will receive the prompt.

### Product and policy

- Consumer subscriptions are per-user; do not pool, proxy, resell, or make one account available to other users.
- Do not represent a local CLI connection as an API key or imply that it works in Forge cloud/mobile.
- Label provider terms that limit commercial, automated, or enterprise use.
- Re-check provider policies before each subscription adapter leaves beta; the Anthropic and Kimi policies changed materially during the period covered by these sources.

## Recommended implementation order

1. Define `ModelRef`, `ProviderConnection`, capability metadata, health states, and billing-source UX.
2. Implement OpenAI API-key discovery and the OpenAI-only Auto router.
3. Implement local Codex app-server using account and model-list RPCs.
4. Add Anthropic, Gemini, Mistral, xAI, DeepSeek, and MiniMax API-key adapters.
5. Add generic OpenAI-compatible endpoints with explicit trust controls and manual model fallback.
6. Prototype Claude Agent SDK as a local external-agent adapter, then complete policy/legal review.
7. Seek written provider clarification before shipping Gemini OAuth or Kimi membership integrations.
8. Add contract tests proving that every model route uses the selected connection, reports the actual model, preserves approvals, and never exposes credentials.

## Final product recommendation

Support the user's broad model ambition, but do not describe every entry as the same kind of model provider:

- **OpenAI Auto** is a Forge routing feature and always resolves to an available OpenAI model.
- **BYOK models** run inside Forge's own tools-and-code harness.
- **Subscription agents** run through supported local provider runtimes and are visibly labeled local.
- **Unsupported consumer subscriptions** are not connected by token extraction or private API emulation.

This preserves the user's choice while keeping billing, capabilities, security, and provider terms honest.
