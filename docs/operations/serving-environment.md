# Serving-environment identity investigation

FOR-25 read-only evidence, 28 October 2026. The complete serving database chain is
**not yet verified**, so production migrations are blocked.

| Surface | Verified deployment | Alias | Region | Source commit |
| --- | --- | --- | --- | --- |
| Web, project `prj_S0XLtdngbexhl2ao7WviBrlMScar` | `dpl_DHbhSDCAubnVvndVKDUgvCCzH5Bu` | `forge-app-mauve.vercel.app` | `iad1` | Missing in deployment metadata |
| Agent runtime, project `prj_NtW13t9fbFligQ3pWV4DdUxW5Mub` | `dpl_12bYPfjiXsMhFB7U2DkjZ4LuDn5r` | `forge-agent-runtime.vercel.app` | `iad1` | Missing in deployment metadata |

Vercel's deployment-alias API confirms these mappings. Both deployments report
READY / production / Node 24. The web and runtime roots return HTTP 200 and the
anonymous web `/api/auth/get-session` endpoint returns 200. Runtime `/health`
returns 404. These requests do not prove authenticated DB queries or an agent
execution.

Current project configuration has readable `BETTER_AUTH_URL` pointing to the web
alias and `EVE_AGENT_RUNTIME_URL` pointing to the runtime alias. Project config is
not proof of the immutable deployment's captured environment. Vercel lists web
`DATABASE_URL` and runtime `FORGE_APP_ORIGIN` as sensitive and withholds their
values. The connector's decrypt request and CLI environment execution did not
reveal them. No production object-storage environment references appear in the
listed variables. Web references include Better Auth, Resend and agent-signing
secrets; runtime references include the agent-channel secret. Secret values are
not included here.

Separately, read-only SQL confirms the **local application's configured** Neon
connection: project `raspy-union-96305162`, branch `br-muddy-queen-zaeeysjt`, database
`neondb`, PostgreSQL 18.6, pooled host
`ep-lingering-bread-zazpwrxp-pooler.c-2.eu-west-2.aws.neon.tech`. Latest journal row:
id 26, timestamp `1792843627355`, hash
`f75aa12984dcf6bc851fb30dd4faf4d314302b9c529a075e0f1ae1594a8a81f1`.
This is **not evidence** that Vercel serves that same branch. Local migration 0026
was applied only to isolated test/staging databases in this implementation.

Before production changes, an operator must verify the deployed connection's
hostname/project/branch/database and migration journal through a trusted runtime
diagnostic or deployment-secret reference, record the actual source revision, and
confirm runtime callback origin plus durable storage configuration. Do not infer a
commit from current Git HEAD or switch production to the local DB merely because
that connection is available. FOR-25 stays In Progress while these gaps remain.
