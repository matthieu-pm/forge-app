# Calls

Calls now has workspace and team views with a day-grouped feed, summary,
decisions, action items, searchable speaker transcripts, and shared notes and
follow-ups. Records live in Postgres and use the active workspace and visible
team authorization boundary. The feed shows the 100 most recent calls.

Native provider imports use OAuth authorization and completed provider
transcripts. Forge does not join meetings, record audio, or start transcription.
A host must enable the provider's transcription and its participant notices.
The connection and manual import flows require acknowledgement of participant
notification and sharing with Forge and OpenAI. This acknowledgement is not a
provider-side consent audit or an automated notification to attendees.

## Setup

Apply `bun run db:migrate` before opening Calls. Configure OAuth apps with this
callback, using the same public origin as `BETTER_AUTH_URL`:

```
https://your-forge-origin/api/calls/oauth/callback
```

Set the matching server-only variables in the application and sync-job runtime:

| Provider | Client variables | Permissions / prerequisites |
| --- | --- | --- |
| Google Meet | `FORGE_GOOGLE_MEET_CLIENT_ID`, `FORGE_GOOGLE_MEET_CLIENT_SECRET` | Meet API enabled; `meetings.space.readonly`; account access to conference records and generated transcripts |
| Microsoft Teams | `FORGE_MICROSOFT_TEAMS_CLIENT_ID`, `FORGE_MICROSOFT_TEAMS_CLIENT_SECRET` | `User.Read`, `Calendars.Read`, `OnlineMeetings.Read`, `OnlineMeetingTranscript.Read.All`, `offline_access`; tenant approval may be required |
| Zoom | `FORGE_ZOOM_CLIENT_ID`, `FORGE_ZOOM_CLIENT_SECRET` | User OAuth app with recording read permission, cloud recording and audio transcription enabled |

`FORGE_MODEL_CREDENTIAL_KEK` encrypts meeting tokens using the existing Forge
server credential vault. OAuth state is short-lived, bound to the initiating
user and workspace, and consumed once. Google and Microsoft also use PKCE.
Credentials are never returned to the browser. Disconnect removes Forge's stored
credentials; account-side app grants can also be revoked at the provider.

A workspace owner/admin opens **Calls → Connections**, chooses the destination
team, confirms participant notice, and authorizes the provider. A provider shows
“Administrator setup required” until its server configuration is present.
Connections import meetings accessible to the account into the selected team.
Existing calls retain their original team if a connection is reassigned.

Run `bun run calls:sync` every five minutes in the application runtime's existing
job scheduler. The job imports the last seven days, skips calls beyond workspace
retention, deduplicates by provider meeting identity, refreshes tokens, generates
pending recaps, and removes expired transcript text. **This command is supplied;
no production scheduler is installed by this change.** Manual Sync imports
transcripts for the current user's connections. New transcripts depend on the
provider finishing processing and the next successful sync; this is not a
real-time delivery guarantee.

Google Meet uses conference resource names as call titles because conference
records do not expose calendar event titles. Teams imports scheduled calendar
meetings organized by the connected user and allowed by Graph permissions. Zoom uses
cloud recording transcripts, never the audio/video recording. Availability
depends on account plan, host settings, and provider permissions.

## Summaries

`OPENAI_API_KEY` powers structured recaps. `FORGE_CALLS_SUMMARY_MODEL` selects
the model. Transcript text is sent to OpenAI with storage disabled; notes and
connection credentials are not sent. Generated decisions and actions are
suggestions and are labelled for human review. API failures preserve the
transcript and expose a retry action. Jobs use leases to avoid repeated summary
writes and overlapping connection synchronization.

A VTT, SRT, or speaker-labelled TXT transcript can also be imported directly.
This is a useful fallback when a provider account is not yet connected. It
creates a real workspace call, then generates its recap.

## Issues

“Create issue” uses Forge's existing team issue store, includes the call and
action in a backlink, and reuses an issue already created from that action in
the same browser. A mentioned owner's name remains context; Forge does not guess
a user ID. The action's completion checkbox is shared through Postgres.

**Existing platform limitation:** Forge's issue backlog is browser-local today.
Created issues and the “created issue” link have the same browser/device scope
as the rest of that backlog. Calls, notes, and action completion are server
persisted. Sharing converted issues across devices requires the separate issue
persistence migration; this change does not claim to have completed that work.

## Retention

Admins choose 7, 30, 90, or 365 days from the call date in Connections. Shortening
retention immediately clears older transcript text. Reads also sweep expired
transcripts; the sync job enforces removal even without visitors. Summaries,
decisions, notes, and action items are kept, as explained in the UI. Provider
copies and OpenAI's processing policies are separate from Forge's transcript
retention setting. The older personal “Calls & transcripts” settings remain
browser-local preferences/preview; they do not configure native capture.

## Verification limits

Provider adapters have mocked API tests. Real OAuth authorization and imports
require registered provider applications and account consent. Test those with
each deployment's callback URL, tenant policies, and an actual transcribed
meeting before enabling a production sync schedule.

Provider contracts: [Google transcript entries](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts.entries/list),
[Microsoft transcript list](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-list-transcripts?view=graph-rest-1.0),
[Zoom OAuth](https://developers.zoom.us/docs/integrations/oauth/),
[Zoom recordings](https://developers.zoom.us/docs/api/rest/reference/zoom-api/methods/#tag/Cloud-Recording).
