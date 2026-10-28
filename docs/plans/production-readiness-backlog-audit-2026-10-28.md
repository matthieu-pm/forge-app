# Pre-implementation backlog review — 28 October 2026

## Review result

The original **124-issue** backlog covered all 31 report headings, but feature-heading coverage concealed missing delivery behavior and over-coupled work. This review read every live issue's full specification and native relationships, compared them with the readiness review, and inspected the owning source for notification preferences, model connections, agent retention and onboarding. The repository remains at `ededa613588aaf885732ec05f6ecbf9cb17f43a4`.

The revised backlog contains **133 issues and 251 native prerequisite links**, down from 296 links despite adding nine issues. **73 existing issues were refined.** Five new items close missing coverage; four preserve existing scope in independently deliverable slices. No issue was deleted, marked Done, assigned an invented owner or given an invented estimate/date.

This is a backlog and specification audit, not a fresh production-readiness certification. No application implementation, deployment, load test or end-to-end test suite was run.

## Missing work now owned by stories

| New work | Why the previous coverage was insufficient | Scope |
| -- | -- | -- |
| [FOR-145](<https://linear.app/atriumcrm/issue/FOR-145/persist-notification-channel-choices-and-enforce-delivery-preferences>) — channel/type preferences | The checked notification-preferences module stores choices in localStorage and exposes desktop/mobile/email/Slack controls. Inbox state and email transport tickets did not own persisted choices, priority-inbox behavior and send-time preference precedence. Unsupported channels must be unavailable. | Feature gated |
| [FOR-146](<https://linear.app/atriumcrm/issue/FOR-146/deliver-authorized-native-notifications-with-safe-deep-links>) — native delivery | Dock badges were covered, but OS notification delivery, permission denial, replay deduplication, privacy and click reauthorization were not. | Feature gated |
| [FOR-147](<https://linear.app/atriumcrm/issue/FOR-147/expire-agent-conversation-data-through-scheduled-recoverable-retention>) — agent data lifecycle | Shared file cleanup and account deletion do not schedule policy-driven expiry of retained runs/messages/events or prove scheduler health. The checked script sweeps artifacts/attachments only. | Feature gated |
| [FOR-148](<https://linear.app/atriumcrm/issue/FOR-148/verify-model-connection-setup-refresh-revocation-and-endpoint>) — model connection lifecycle | Keyring rotation and live-provider evals do not fully own personal/workspace connection setup, refresh, revocation and changed endpoint routing. Existing services are reused and verified. | Feature gated |
| [FOR-149](<https://linear.app/atriumcrm/issue/FOR-149/enforce-browser-request-origins-and-session-trust-boundaries>) — browser session/origin boundary | The source report explicitly required CSRF/origin/CORS acceptance, but no issue owned that complete matrix. Existing auth controls must be verified, not presumed absent. | Core production |

Additional gaps were resolved inside their existing owners: fresh-account workspace/team bootstrap and email ownership proofs in [FOR-97](<https://linear.app/atriumcrm/issue/FOR-97/verify-signup-email-change-account-linking-and-workspace-invitations>); failed recovery mail in [FOR-96](<https://linear.app/atriumcrm/issue/FOR-96/recover-password-access-with-single-use-verified-reset-flows>); token refresh/disconnect races in [FOR-71](<https://linear.app/atriumcrm/issue/FOR-71/connect-reconnect-and-disconnect-meeting-providers-in-production>); unsafe rich text in [FOR-46](<https://linear.app/atriumcrm/issue/FOR-46/discuss-issues-with-durable-comments-and-mentions>) / [FOR-61](<https://linear.app/atriumcrm/issue/FOR-61/create-and-edit-shared-documents-with-revision-conflicts>); command/approval crash points and revoked-result replay in [FOR-32](<https://linear.app/atriumcrm/issue/FOR-32/commit-commands-receipts-audit-and-outbox-events-atomically>) / [FOR-80](<https://linear.app/atriumcrm/issue/FOR-80/execute-approved-agent-writes-with-crash-safe-command-receipts>); late upload authorization in [FOR-35](<https://linear.app/atriumcrm/issue/FOR-35/upload-files-directly-with-validated-upload-intents-and-finalize>); and bounded operating limits in [FOR-24](<https://linear.app/atriumcrm/issue/FOR-24/agree-capacity-service-and-recovery-objectives>).

## Bundled scope split without dropping functionality

| Prior coupling | Revised ownership |
| -- | -- |
| Runtime preference schema/defaults depended on account import and ownership policy. | [FOR-128](<https://linear.app/atriumcrm/issue/FOR-128/validate-and-safely-migrate-personal-preference-schemas>) is a pure schema/scope/default contract; [FOR-127](<https://linear.app/atriumcrm/issue/FOR-127/keep-personal-preferences-consistent-across-authenticated-sessions>) consumes it; [FOR-144](<https://linear.app/atriumcrm/issue/FOR-144/import-legacy-personal-preferences-without-overwriting-account-choices>) separately owns legacy import consent, conflicts and resumption. |
| Basic planning API waited for initiative/project-progress implementation. | [FOR-88](<https://linear.app/atriumcrm/issue/FOR-88/expose-authorized-projects-cycles-labels-and-initiatives>) owns basic projects/cycles/labels; [FOR-150](<https://linear.app/atriumcrm/issue/FOR-150/expose-enabled-initiative-and-advanced-project-metadata-through-the>) owns initiatives and advanced milestones/updates. |
| Planning/inbox agent context waited for both documents and meeting-provider sync. | [FOR-82](<https://linear.app/atriumcrm/issue/FOR-82/let-forge-use-authorized-cycles-documents-inbox-and-call-recaps>) owns cycles/inbox; [FOR-151](<https://linear.app/atriumcrm/issue/FOR-151/let-forge-read-authorized-documents-with-source-references>) owns document reads; [FOR-152](<https://linear.app/atriumcrm/issue/FOR-152/let-forge-read-authorized-call-recaps-with-provenance>) owns call recap reads. |

The four split-out items are [FOR-144](<https://linear.app/atriumcrm/issue/FOR-144/import-legacy-personal-preferences-without-overwriting-account-choices>), [FOR-150](<https://linear.app/atriumcrm/issue/FOR-150/expose-enabled-initiative-and-advanced-project-metadata-through-the>), [FOR-151](<https://linear.app/atriumcrm/issue/FOR-151/let-forge-read-authorized-documents-with-source-references>), [FOR-152](<https://linear.app/atriumcrm/issue/FOR-152/let-forge-read-authorized-call-recaps-with-provenance>). Existing parent stories were narrowed accordingly; the split does not duplicate their acceptance obligations.

## Duplicates and overlap

No exact duplicate titles or fully redundant user outcomes were found. Similar infrastructure and acceptance gates are retained when they own distinct deliverables.

| Overlap reviewed | Resolution |
| -- | -- |
| [FOR-33](<https://linear.app/atriumcrm/issue/FOR-33/deliver-external-effects-with-recoverable-outbox-processing>) and [FOR-64](<https://linear.app/atriumcrm/issue/FOR-64/run-leased-resumable-background-jobs-with-operator-recovery>) both described leases/retries/dead letters. | The job runner owns generic execution/recovery. Outbox owns event/provider semantics and consumes that runner. There is one lease/retry substrate, with separate acceptance for ambiguous external effects. |
| [FOR-47](<https://linear.app/atriumcrm/issue/FOR-47/react-to-comments-and-subscribe-to-issue-activity>), [FOR-66](<https://linear.app/atriumcrm/issue/FOR-66/sync-read-snooze-delete-and-subscription-state-across-devices>) and notification preferences mixed subscription/state concepts. | Issue subscription belongs to the first; read/snooze/hide/replay belongs to inbox state; channel/type delivery policy belongs to [FOR-145](<https://linear.app/atriumcrm/issue/FOR-145/persist-notification-channel-choices-and-enforce-delivery-preferences>). Inbox-item deletion never unsubscribes or deletes an issue. |
| [FOR-102](<https://linear.app/atriumcrm/issue/FOR-102/sync-editable-profile-extras-across-authorized-sessions>) and [FOR-127](<https://linear.app/atriumcrm/issue/FOR-127/keep-personal-preferences-consistent-across-authenticated-sessions>) share account persistence patterns. | They keep separate records and ownership contracts. Profile no longer waits for cosmetic preference implementation. |
| [FOR-34](<https://linear.app/atriumcrm/issue/FOR-34/store-all-agent-and-issue-files-durably-in-private-object-storage>), [FOR-48](<https://linear.app/atriumcrm/issue/FOR-48/attach-durable-files-to-issues-and-comments>) and [FOR-83](<https://linear.app/atriumcrm/issue/FOR-83/use-durable-attachments-and-artifacts-throughout-an-agent-run>) all mention files. | Retain adapter durability, issue/comment binding and agent-runtime transfer as distinct outcomes. [FOR-37](<https://linear.app/atriumcrm/issue/FOR-37/reconcile-orphaned-files-and-retry-durable-deletion>) owns shared byte deletion; [FOR-147](<https://linear.app/atriumcrm/issue/FOR-147/expire-agent-conversation-data-through-scheduled-recoverable-retention>) owns agent-specific eligibility/scheduling. |
| Implementation tests and release gates overlap scenarios. | Implementation issues prove their slice; release gates prove the selected candidate, deployment and enabled surface. A gate must not become a second implementation project. |

## Unnecessary blockers corrected

| Before | Now and rationale |
| -- | -- |
| [FOR-64](<https://linear.app/atriumcrm/issue/FOR-64/run-leased-resumable-background-jobs-with-operator-recovery>) waited on outbox and final operational alerts. | Runner depends on transactional identities and telemetry hooks; outbox consumes it. Final alert evidence stays a core release requirement. |
| Comments waited on an asynchronous delivery worker. | Comment writes emit atomic outbox rows through the command foundation; actual fan-out has its own owner. |
| Cycles waited on projects; recurrence always waited on cycles. | Team issue/cycle membership can be built independently of projects. Recurrence validates a cycle only when that option is selected. |
| Profile waited on preferences; external import waited on Forge export. | Both use shared foundations without forcing the neighboring product feature to ship first. |
| Basic API release waited on webhooks. | Webhooks have conditional enablement evidence; basic API may ship with registration/dispatch disabled. |
| Read-only MCP waited on issue mutation endpoints. | It uses the canonical read service and credential scopes directly. |
| MCP writes and user-approved PR feedback waited on internal agent approvals/runs. | They use shared command identities and explicit transport-specific authority. They never fabricate an internal run or require model execution for a human-approved operation. Autonomous agent posting remains outside the review story. |
| Skills waited on the full issue/project tool catalog; outbound connector reads waited on skill authoring. | Run-context and authorization contracts are the relevant prerequisites. Enabled material writes still require their approval evidence. |
| Every preference consumer waited on legacy import policy. | Consumers depend on the schema/account contract; import is separate. |
| Native adapters waited on the completed packaged-security gate. | Adapter implementation uses the existing trusted bridge and its own negative tests. The full packaged security gate remains mandatory before desktop distribution. |
| Preference gates required every optional control even when explicitly excluded. | Gates require shared safety/release foundations plus a **selected-surface evidence matrix**. Related links identify conditional implementations. Missing evidence for any enabled control still blocks release. |
| Password recovery and invitation verification waited on the collaborative domain schema/job runner. | Existing account-auth/mail flows can be implemented and verified independently. Current authorization, cookie/origin and delivery-failure requirements remain intact. |

Transitive links were also removed where another retained prerequisite already enforces the same ordering. The audit changed 95 existing blocking links by removal and added 32 replacement/required links; the nine new issues contribute 18 links. Arithmetic: **296 − 95 + 32 + 18 = 251**. This count includes structural cleanup and scope changes; it does not claim 95 distinct product defects.

One genuine missing implementation prerequisite was added: [FOR-35](<https://linear.app/atriumcrm/issue/FOR-35/upload-files-directly-with-validated-upload-intents-and-finalize>) requires shared [FOR-39](<https://linear.app/atriumcrm/issue/FOR-39/enforce-one-authorization-policy-across-ui-api-tools-and-jobs>) for upload intent/finalize permission checks. The core candidate gate now requires [FOR-149](<https://linear.app/atriumcrm/issue/FOR-149/enforce-browser-request-origins-and-session-trust-boundaries>). Agent release evidence now includes connection lifecycle and agent retention.

## Dependency and release rules

Native blocking links identify prerequisites for completing the acceptance contract. Preparation and fixture-based implementation can proceed concurrently once interfaces are agreed; a blocked issue does not forbid design work.

A related link is not an automatic prerequisite. **Conditional evidence is mandatory when its feature is selected**: webhooks, advanced API endpoints, skills/domain tools and optional preference/native controls must either pass their stated checks or be explicitly excluded by [FOR-20](<https://linear.app/atriumcrm/issue/FOR-20/agree-the-production-release-scope-and-feature-gates>) and enforced by [FOR-103](<https://linear.app/atriumcrm/issue/FOR-103/disable-unfinished-features-consistently-across-ui-and-server-routes>). A release gate cannot close just because its unconditional blockers are Done.

The accepted release manifest must list each enabled capability, its implementation/gate issue, candidate evidence and owner. Exclusion never closes an unfinished implementation issue. No features were silently removed in this audit.

## Verification of the saved backlog

* Read back **all 133 issues**, including native relationships.
* Titles, priorities, labels, milestones, Backlog status and intended prerequisites match the revised plan.
* **251 prerequisites**, all inside this project; **no dependency cycles**.
* **All 57 core-production items** are connected to core launch, except the launch issue itself and the explicitly subsequent post-launch check.
* **No feature-gated or later-expansion item is an unconditional ancestor of core launch.**
* No archived preference issue references or unresolved authoring placeholders remain in issue descriptions.
* Every stable AC ID has a corresponding AT specification. This is a structural check; it does not imply that tests have passed or that every policy has been approved.
* Semantic duplicate review found the ownership overlaps above, not tickets that should be deleted.

## What can start and what still needs refinement

Three work items have no native prerequisites: [FOR-25](<https://linear.app/atriumcrm/issue/FOR-25/identify-the-serving-production-services-and-database>) (serving-environment identity), [FOR-20](<https://linear.app/atriumcrm/issue/FOR-20/agree-the-production-release-scope-and-feature-gates>) (release contract), and [FOR-128](<https://linear.app/atriumcrm/issue/FOR-128/validate-and-safely-migrate-personal-preference-schemas>) (pure preference schemas/defaults). Foundation work can start while product decisions are resolved; policy-dependent acceptance cannot be signed off in advance.

| Decision still needed | Owning issue |
| -- | -- |
| Pilot audience, enabled providers/clients/channels/modules, individual release owners, and unavailable/preview behavior | [FOR-20](<https://linear.app/atriumcrm/issue/FOR-20/agree-the-production-release-scope-and-feature-gates>) |
| Cross-team projects, private-team aggregates and sharing rules | [FOR-21](<https://linear.app/atriumcrm/issue/FOR-21/decide-project-team-and-shared-resource-visibility-rules>) |
| Browser-data ownership, destination choices, duplicate/conflict handling and cleanup | [FOR-22](<https://linear.app/atriumcrm/issue/FOR-22/decide-ownership-and-conflict-rules-for-legacy-browser-data>) |
| Raw/derived/agent data lifetimes, account deletion and backup/restore exceptions | [FOR-23](<https://linear.app/atriumcrm/issue/FOR-23/define-retention-and-accountworkspace-deletion-behavior>) |
| Workload, measurable service/recovery objectives, storage/processing limits and retry windows | [FOR-24](<https://linear.app/atriumcrm/issue/FOR-24/agree-capacity-service-and-recovery-objectives>) |
| Provider modes, spend/concurrency/deadline policy and disconnect behavior | [FOR-75](<https://linear.app/atriumcrm/issue/FOR-75/define-provider-spending-and-execution-admission-policy>) |
| MCP transport/client compatibility and delegated versus pending-approval writes | [FOR-91](<https://linear.app/atriumcrm/issue/FOR-91/choose-external-mcp-transport-client-support-and-write-authority>) |
| Paid-plan provider, entitlements and commercial lifecycle, if charging | [FOR-109](<https://linear.app/atriumcrm/issue/FOR-109/agree-plans-entitlements-and-subscription-lifecycle-rules>) |
| Channel precedence and mandatory versus optional messages; OS permission/preview behavior | [FOR-145](<https://linear.app/atriumcrm/issue/FOR-145/persist-notification-channel-choices-and-enforce-delivery-preferences>), [FOR-146](<https://linear.app/atriumcrm/issue/FOR-146/deliver-authorized-native-notifications-with-safe-deep-links>) |
| SLA business hours, DST/catch-up behavior, selected integration providers and import formats | Refine [FOR-125](<https://linear.app/atriumcrm/issue/FOR-125/enforce-shared-sla-schedules-and-escalation-policy>), [FOR-68](<https://linear.app/atriumcrm/issue/FOR-68/generate-one-canonical-issue-for-each-recurring-occurrence>), [FOR-71](<https://linear.app/atriumcrm/issue/FOR-71/connect-reconnect-and-disconnect-meeting-providers-in-production>), [FOR-104](<https://linear.app/atriumcrm/issue/FOR-104/manage-authorized-external-connections-and-applications>), [FOR-114](<https://linear.app/atriumcrm/issue/FOR-114/import-supported-external-datasets-with-preview-and-reconciliation>) before implementing their selected modes. |

[FOR-126](<https://linear.app/atriumcrm/issue/FOR-126/migrate-legacy-planning-content-and-shared-views-when-enabled>) remains the planned advanced-content migration batch. If documents, views and initiatives are launched on different dates, split its adapters by the accepted module rollout before scheduling that batch; preserved local records must remain recoverable meanwhile. Provider-specific OAuth and external-format imports similarly need provider/format-sized execution tasks once their supported set is chosen. No estimates or rollout dates were invented to hide those choices.

**INVEST assessment:** value and testable outcomes are explicit; dependency cleanup improves independent delivery; unresolved policy keeps stories negotiable. Estimated size and sprint fit still require product/development/test refinement, especially provider integrations, deletion/export data classes and advanced-content migration. No workshop or stakeholder approval is claimed.
