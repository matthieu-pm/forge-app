# Linear Loops reference for FOR-62

Checked 2 November 2026. This describes the reference product; Forge's accepted release contract is recorded separately in FOR-62. The investigation created no Linear objects and enabled no automations. No vendor source is included in this repository.

## Evidence and boundaries

**Live UI:** the signed-in Loops editor exposed Schedule, Issue, Project, Initiative, Cycle, Team, Slack, Pull request and Webhook. The native app rendered a blank window; the authenticated browser supplied the usable UI. Native object menus and issue filters were inspected without saving a Loop.

**Static client:** public assets reached from `https://linear.app/atriumcrm` exposed a named trigger registry, schemas and validation. The focused [AutomationHelper asset](https://static.linear.app/client/assets/AutomationHelper.CoYw_JIW.js) has SHA-256 `f5815108981ab62fc3eb37a29723130ed7b8e6dc68751056b05f2234c4c2129b`. Its imported [startup schema](https://static.linear.app/client/assets/startup-entry.BffsFlyR.js) supplies the constants and lower-level variants below. Static syntax establishes client configuration, not backend execution.

REA analyzed the helper, editor and connectors: parent `ev_6ee769f231ecfabdb650a21800781671cca51cad0f7a009e50f787c198f08068`, summary `ev_48b73dd8639b6c60aae180a5711bb5e3236bf173ec332618706da12e467d80c5`; directory digest `a5de941a131b7276c1d6c68f81f1858052e808df4ef8618dc968c439e2f5ecea`. Parsing covered all three selected files (100,640 bytes); dependency behavior and dynamic semantic relationships remain unresolved. Linear desktop 1.32.7 is a shell that loads the hosted app; its ASAR alone cannot establish Loops behavior.

**Published documentation:** [Linear's Loops documentation](https://linear.app/docs/loops) corroborates setup and lifecycle behavior. Webhooks accept authenticated JSON POSTs and a reusable event ID; acceptance confirms receipt. Slack needs an eligible integration and public top-level messages, with exclusions for replies, edits and several sender types. GitHub requires authorized connected repositories. Published versions and run history are available. Team, workspace and individual edit permissions are configurable. Manual execution supports enabled schedule, issue, project and initiative Loops; the documentation excludes cycles, despite the broader client helper. Limits include 100 team Loops, 500 workspace Loops and 100 unpublished drafts per person. These are reference-product limits, not adopted Forge promises.

## Trigger catalogue

The following is the complete selected client **picker registry**, corroborated by live UI where noted. Gated or schema-only entries are distinguished below.

| Category | Picker choices | Evidence |
| --- | --- | --- |
| Schedule | Recurrence with timezone, first date, time and interval | UI, schema |
| Issue | Created; is in triage; property updated; status, priority, assignee, agent, cycle, project, team changed; labels added/removed; new comment; new customer request | UI, registry |
| Issue estimate | Estimate changed | Registry; depends on estimation availability |
| Project | Created; property updated; status, lead, priority changed; labels added/removed; target date updated; description updated; update posted; new comment; new customer request; milestone updated | UI, registry |
| Initiative | Created; property updated; status/owner changed; labels added/removed; projects changed; target date/description updated; update posted; new comment | UI, registry |
| Cycle | Created; started; completed | UI, registry |
| Team | Created; members joined/left | UI, registry |
| Slack | Message posted | UI, registry |
| Pull request | Created; ready for review; status change; reviewer or reviewer-team added/removed; label added/removed; commits pushed; checks passed/failed; review submitted; merge-queue added/removed; new comment; comment resolved | UI category, registry |
| Webhook | Authenticated incoming event | UI category, documentation |
| Release | Created; stage changed | Registry, not exposed in the inspected workspace |

Lower-level schemas also represent Document created/updated/created-or-updated and Slack reaction-added events. Generic deleted/unarchived event names exist. These do not establish usable picker choices and must not become enabled Forge functionality merely because strings or schemas exist.

## Matching rules

The model stores one trigger: its plural `allTriggers` accessor returns only `firstTrigger`, and its setter consumes the first item. Four activation modes are represented: condition transition, any update, watched-property change and collection change. Triage uses condition transition. Generic property updates use any-update matching. Scalar changes can qualify destination values; collection changes distinguish additions from removals and can qualify the changed labels. Current labels and changed labels are different predicates.

Comment matching distinguishes any comment including replies, a top-level thread, a case-insensitive literal substring, and a linked mention of any selected user. Text matching is not regex; it requires nonblank text of at most 1,000 characters. A name appearing as plain text does not satisfy a mention condition.

Filters support nested AND/OR groups. The client separates a trigger's own filters, change metadata and additional conditions. It caps workflow conditions at eight and activity definitions at eight; names/group names at 64 characters and descriptions at 255.

Issue filter schema covers team/status/assignment/creator/priority/labels/project/subscribers/SLA/cycle/parent; text, attachments, relationships and subissues; cycle periods; relationship and suggestion predicates; estimate/source/template; lifecycle dates; and customer-request counts. Project filters cover IDs, teams, lead, creator, members, status, priority and labels. Initiative filters cover selected IDs, owner/creator, teams, status/priority/labels and projects. Team filters cover ID/name/parent/users/owners/privacy. Release filters cover pipeline/stage. Cycle has no arbitrary entity filter fields. Unsupported cross-entity filters and certain current-user project predicates are rejected.

Schedules represent hours, days, weeks, months and years with a positive integer interval, first date, hour, optional minute and timezone. Weekly days must be unique, nonempty and limited to seven; other units cannot carry weekday selection. Client helpers calculate future occurrences and distinguish elapsed hours from calendar recurrence. That code does not prove server catch-up, DST or retry guarantees.

## Access is separate from matching

The client validates that data scope contains the owning team and trigger teams, respecting private/restricted boundaries. Triage and cycle availability depend on the respective team features. Slack validates a connected eligible workspace and 1–20 channels; its reaction schema caps emojis at ten. Pull requests require at least one repository.

Separate capability policy controls team data access, changes outside the triggering entity, web access, code reading/coding sessions, externally synced records, trusted sources and connector tools. Tool availability and automatic approval are separate settings. Scope and connector configuration do not grant access to otherwise unauthorized objects.

## Forge implementation decisions and remaining unknowns

The user selected real agent Loops, management by every member with team access, native Forge events, schedules and authenticated webhooks. Slack and GitHub remain unavailable until their integration contracts exist. No unsupported Release or customer-request model is introduced.

Team-scoped Loops see initiatives through linked project teams; an initiative with no linked team has no team audience. The accepted permission model follows the reference: public-team Loops may access all public teams; private-team Loops remain limited to their own team. Events are recorded per source team, and all-public matching cannot widen private-team access. Shared model connections and service execution replace the earlier proposed personal-enabler model; published edits retain the enabled state. Native row producers cannot detect time passing: a separately scheduled scanner must emit cycle-start/end events using each saved cycle's timezone. SQL events contain domain snapshots and immutable event IDs; the worker must reauthorize the current actor and current object before executing.

Client inspection does not establish backend event identity, retries, leases, deduplication, recursive-trigger suppression, spend reservation, crash recovery or cancellation after revocation. Forge must define and verify those guarantees independently. A matching reference menu is not evidence of production equivalence.
