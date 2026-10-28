# Email verification before workspace and agent use

The public web, Forge agent and macOS release requires verified email ownership
before workspace creation or agent use (user decision, 28 October 2026).

Password signup sends verification mail and does not grant an unverified session.
The signup screen displays a verification notice instead of navigating into the
workspace. An unverified password sign-in displays the same resend control.
Resend reports delivery failures and keeps desktop authorization query parameters
in the verification callback, so the user can verify and then sign in to continue.
Verification uses the existing Better Auth token/expiry implementation and mailer.

Workspace creation is restricted by the organization plugin's server-side
`allowUserToCreateOrganization` policy. Invitation acceptance explicitly requires
verification as well. Browser-supplied owner IDs do not bypass this policy.
Trusted server-only administrative calls without request headers remain governed
by Better Auth's internal system-action semantics and must not be exposed publicly.

Existing database-backed sessions are checked on each protected workspace/agent
request. Missing/false verification state is denied before loading membership.
Agent HTTP requests receive `403 EMAIL_NOT_VERIFIED` before domain actions. Public
navigation does not adopt an unverified session into a workspace. There is no
automatic verification or grandfathering of legacy users.

Local regression checks cover the real auth handler with a mock SQL transport,
old-session denial, verified-session behavior, agent transport denial, signup,
resend failure/retry and desktop callback preservation. Live delivery, deployed
email-change/linking/invitation flows and packaged desktop verification still
belong to FOR-97 and the desktop release gates. No production data is migrated by
this change.
