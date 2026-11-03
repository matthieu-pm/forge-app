# Linear SLA behavior and evidence

Research for [FOR-125](https://linear.app/atriumcrm/issue/FOR-125), 3 November
2026. The user requested reverse-engineering Linear before defining Forge's
policy. The resulting [Forge contract](../shared-sla-contract.md) distinguishes
reference behavior from Forge decisions.

## Findings

| Question | Finding | Authority |
| --- | --- | --- |
| What is measured? | Issue completion against a deadline. | [Issue property documentation](https://linear.app/docs/issue-property#slas) |
| Which automation wins? | Rules are ordered; the first match applies or removes an SLA. | Same documentation |
| When are rules evaluated? | Creation and issue updates; editing a rule does not backfill existing issues. | Same documentation |
| What starts the clock? | The current client exposes rule-match and issue-creation modes. | Settings bundle S1; [September 2026 release](https://linear.app/changelog/2026-09-03-priority-inbox) |
| What does business time mean? | Whole working days, excluding days outside the selected work week. | [Business-day release](https://linear.app/changelog/2024-11-13-improvements-for-slas-templates-and-jira-and-github-issues-sync); helper S3 |
| Who owns the calendar? | The work-week setting belongs to the workspace; the client passes the issue team's timezone into risk calculations. | Bundles S1 and S4 |
| What happens on completion? | The result stays visible as achieved or failed. The client treats completion exactly at the deadline as failed. | Documentation; client classifier S4 |
| What happens on cancellation? | The inspected client classifier suppresses SLA status for canceled issues. | S4; server persistence remains unknown |
| Does reopening reset the clock? | A 2024 release describes resetting an achieved/breached SLA older than a month. Current handling of other cases is unverified. | [October 2024 release](https://linear.app/changelog/2024-10-10-document-subscriptions) |
| Does escalation reassign work? | No inspected source establishes an escalation ladder or automatic reassignment. The settings label refers to when a rule matches. | S1; bounded documentation search |

The main documentation also describes manual SLAs, replacing ordinary due dates,
six risk/outcome buckets, and subscriber Inbox alerts before and at breach.
Team-wide alert subscriptions are optional. These features do not establish a
backend implementation or delivery guarantee for Forge.

## Shipped client evidence

The current public application bootstrap was obtained from
`https://linear.app/login`, then its literal asset references were followed to
the settings, SLA, date-helper and shared model bundles. Sources were read as
inert text; no downloaded bootstrap was executed. Digests and source coordinates
are recorded in [the evidence manifest](linear-sla-evidence.json).

- **S1 — SLA settings.** The editor saves an ordered workflow definition with
  issue filters and an add/remove action. It exposes `ruleMatch` and
  `issueCreation`, two work-week presets, and custom durations in hours, days,
  business days or weeks. Client validation permits positive integer durations,
  bounded to approximately one year. It has no intraday business-hours or
  pause-state control. Static UI checks use a workspace SLA permission; they
  do not prove server authorization.
- **S2 — SLA filter definitions.** The client distinguishes open breached work
  from completed failed work and offers risk and completion filters.
- **S3 — date helper.** Business-day offsets advance calendar dates, testing
  membership in the supplied working-day set. With a timezone, it uses the
  timezone-aware date library; without one, it uses local `Date` operations.
  A zero offset returns the original date. This is neither office-hour budget
  accounting nor proof of server-side DST disambiguation.
- **S4 — shared issue model.** Calendar risk thresholds subtract 24 hours and
  seven days; business-day thresholds subtract one and seven working days.
  Calculations receive team timezone and workspace working days. Client display
  classification uses the device clock, while stored deadline fields are
  separate. That presentation behavior must not become Forge's deadline authority.

REA analyzed the two focused SLA bundles and the date-helper bundle. File
inventory/parsing completed for these selected inputs; semantic coverage remains
unknown because dependencies and dynamic values were unresolved. The model
bundle was inspected manually at recorded coordinates, not represented as a
complete REA analysis.

### REA records

| Scope | Parent analysis evidence | Result |
| --- | --- | --- |
| Public SLA settings and filter bundles | `ev_b324a2d109d8e9553271ac522d41e7ccf1fd23fe89555047e659aa1a32eb9b68` | Two selected files parsed; unresolved dynamic semantics |
| Public date-helper bundle | `ev_02a3ab07df762ae50d994a98995e085ac2f15b1bb554bccd0bd9ffb72c8d5014` | One selected file parsed; dependencies unresolved |
| Installed Linear 1.32.7 shell | `ev_bff57cede86f72ced03bc311bd9e6df1bfb86b69ed23f7fd138c995b35bf72e5` | Partial; native companion integrity mismatches and semantic worker heap limits |

The installed shell is not evidence of the hosted backend. Its integrity
mismatches concern three native input/haptics companions; analysis proceeded
with explicit record-and-continue and preserved that limitation. No claim here
depends on those companions. Complete REA records were exported locally to
`/tmp/for125-linear-rea-complete.json`; this temporary export contains third-party
source and is not a repository dependency. The checked-in manifest contains only
source identities, coordinates and findings.

The running Linear app was observable through accessibility. Attempts to open
web settings did not produce a changed page; coordinate operations reported
`noWindowsAvailable`. Its discovered loopback listener was not a CDP endpoint.
Consequently there was no authenticated settings mutation, controlled issue
experiment, live deadline transition or provider-delivery observation. No live
workspace SLA settings were changed.

## Remaining limits

Backend rule reapplication, pause/resume, all reopen cases, DST gaps and overlaps,
policy updates during active commitments, scheduling cadence, and exactly-once
effects are not established by this inspection. Absence of an editor control
does not prove absence of a backend feature. Forge defines these cases explicitly
in its own contract rather than claiming exact Linear parity.

The first-release manifest makes SLA conditional on FOR-125 acceptance. Forge's
existing route and source-owned feature ceiling are disabled at inspected
revision `9952f50`. FOR-42 and FOR-64 are Done in Linear. FOR-65 and FOR-145 are
still Backlog, so subscriber Inbox delivery is a conditional extension of the
deadline/breach slice, not an already-working transport.
