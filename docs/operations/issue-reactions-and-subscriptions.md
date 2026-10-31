# Issue reactions and subscriptions (FOR-47)

Canonical issue descriptions, comments and replies support per-user emoji reactions. Issue subscriptions belong to individual users. These values live in the existing canonical `issues.properties` aggregate and are read through the authorized issue projections, including subscribed issue queries. No migration or feature flag is required.

## Ownership and command semantics

`issues.engagement@1` accepts an explicit desired state: `reaction` with `present`, or `subscription` with `subscribed`. It derives ownership from the live authenticated actor; there is no target-user or whole-list input. Session actors, authorized API-key owners and delegated agent owners use the same policy. Workspace admins cannot change another user's reaction or subscription.

The command takes the issue graph lock and row lock before merging the actor's change into current state. It shares this order with comment/lifecycle commands. Other users' choices, concurrent comment edits and unrelated issue properties are preserved. Reactions do not alter comment content versions. Equivalent emoji presentation forms share a normalized identity, and each user appears once per emoji and target. The server validates emoji against the picker vocabulary and limits each target to 100 distinct emoji.

Atomic command receipts, audit and outbox records use the existing command runner. Exact retries return the receipt and current authorized projection without applying the change again. A fresh command whose desired state is already satisfied creates a receipt/audit record, but no activity event or issue revision. A replay of an older add request after a later removal cannot resurrect the reaction. Deleted comments and archived/deleted/inaccessible issues reject new writes; live access is also checked before receipt replay.

General issue-edit commands reject subscriber-list fields and cannot replace reactions. Creation retains the existing creator subscription. Commenting, reacting, assignment and mentions do not implicitly subscribe or resubscribe a user. Unsubscribing preserves all discussion.

## Browser behavior

Shared issue controls and the inbox subscription action write the same canonical state. The subscriber avatars are informational; the old shared list editor is removed. The legacy prototype controls retain their existing local behavior.

Before publishing, the browser persists the exact command in private authenticated product state under `forge:issue-engagement-draft:v1:<issueId>`. An uncertain outcome offers **Retry discussion change**, blocks new engagement intent for that issue, and restores the same command after reload. Confirmed saves and definitive input rejections clear the pending copy. Account/session epochs fence old responses and pending state. Issue-copy authorization/recovery/purge filtering covers the new namespace.

## Notification policy accepted on 31 October 2026

Matthieu confirmed in the implementation conversation that unsubscribing suppresses optional updates while assignments and direct mentions remain independent, subject to account notification settings.

The internal `issueNotificationEligibility` contract is for the future FOR-65 delivery worker. Given a committed server event and a candidate user, it evaluates current workspace membership, private-team/resource access, issue lifecycle, self-event suppression and subscription state:

- Comments, replies, status, issue updates and reactions require a current subscription.
- Assignments and mentions require the event's explicit recipient and bypass the subscription check.
- Self-events and recipients without current issue access are ineligible.
- Inbox eligibility is independent of external alert channels. External alerts also require the channel to be enabled and include the event type; optional updates additionally require the channel's “Subscribed issues” setting.

This function is server-only and is not a client recipient-selection endpoint. FOR-65 must supply trusted committed events, evaluate each recipient immediately before delivery, and own ordering, grouping and deduplication. FOR-33 owns delivery transport/recovery. FOR-47 does not claim that inbox entries or external alerts are being delivered.

## Events and validation

State transitions atomically emit `issue.subscription.changed` or `issue.reaction.changed` with server-derived issue/team/actor IDs and the desired state. Reaction events identify a comment when applicable. These are facts for downstream consumers, not client-supplied recipient lists. Existing comment/mention producer events remain independent of subscription state.

Run:

```sh
FORGE_ISSUE_ENGAGEMENT_TEST_DATABASE_FILE=<isolated-config> bun run --cwd apps/forge test:issue-engagement:postgres
FORGE_ISSUE_ENGAGEMENT_TEST_DATABASE_FILE=<isolated-config> bun run --cwd apps/forge test:issue-engagement:browser
```

The PostgreSQL suite uses the dedicated acceptance database and actual application role. Browser acceptance requires a local server connected to that same database (default `http://localhost:3147`); it creates three real sessions, exercises two independent browsers for Bob, subscription/reaction sync and post-commit response loss, then removes all fixtures. Neither script targets production. Validation results and release boundaries are recorded in `for47-acceptance-evidence.json`.
