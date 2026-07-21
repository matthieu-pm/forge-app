# AI call transcripts without a meeting bot

Research date: 2026-07-21. Sources are first-party documentation. This is a product/technical assessment, not legal advice.

## Executive summary

There are three practical architectures that do not add a visible bot attendee:

1. **Platform-native transcript artifacts (recommended default):** the meeting platform performs speech recognition; our integration receives an availability event after the meeting, fetches the transcript through OAuth, normalizes speaker/timestamp data, and runs our own AI for summaries, action items, CRM updates, and search.
2. **Platform real-time media access:** Zoom RTMS can stream live meeting media directly to an authorized application without a participant bot. Our backend runs streaming ASR and downstream AI. This is the main option when post-call latency is unacceptable.
3. **Participant-side capture:** a browser extension or desktop application captures the participant's microphone plus tab/application/system output, then transcribes locally or uploads encrypted audio. This works across platforms but has the weakest reliable speaker identity and the greatest consent, support, and privacy burden.

Teams and Google Meet provide native transcription independently of recording. Zoom now has retained **Meeting transcripts** independently from its older cloud-recording transcription path; Zoom RTMS is the more flexible real-time custom path.

## Recommended product design

Use native artifacts first and local capture only as a fallback:

```text
Calendar/provider connection
        -> native transcription enabled by organizer/admin
        -> provider artifact-ready webhook (or polling)
        -> OAuth fetch of VTT / structured transcript entries
        -> normalize {meeting, speaker, start, end, text}
        -> AI enrichment (summary, decisions, actions, topics)
        -> encrypted storage with configurable retention/deletion
```

This architecture has no attendee bot, preserves the platform's participant identity mapping, uses built-in recording/transcription notices, and avoids storing raw audio when the transcript is sufficient. Its main limitation is that external customers may not control the organizer's tenant settings or be allowed to enable transcription.

## Platform comparison

| Platform/path | No bot | Recording required | Availability | Speaker attribution | Main restriction |
|---|---:|---:|---|---|---|
| Zoom Meeting transcript | Yes | No | Live in Zoom; downloadable after processing | Provider-generated; quality/identity should be treated as fallible | Host/admin must enable it; paid account requirements and retention policy apply |
| Zoom RTMS + our ASR | Yes | No | Real time | Requires our diarization or separate media metadata | RTMS app/account enablement and in-meeting authorization |
| Zoom cloud recording transcript | Yes | Yes | Post-meeting, after recording and transcript processing | Timestamped VTT; may contain `Unknown Speaker` | Pro+ plan, cloud recording, and audio transcription |
| Microsoft Teams transcript + Graph | Yes | No | Live in Teams; Graph artifact after availability notification | Timestamped VTT with speaker tags when attribution is permitted | Tenant policies, Graph permissions, and meeting-type limitations |
| Google Meet transcript + Meet API | Yes | No | Post-meeting structured entries/file; event available | Each entry references a Meet participant | Eligible Workspace edition, host controls, Drive capacity, OAuth |
| Participant-side capture | Yes | No platform recording | Real time or immediately post-call | Usually only `local user` vs mixed remote audio; remote speakers need diarization | OS/browser capture permissions, consent, capture reliability |

## Zoom

### A. Native Meeting transcripts

Zoom's current Meeting transcript feature retains speech-to-text without requiring a cloud recording. A host starts it from **More -> Transcript**, participants may request it, and the transcript panel populates during the call. Transcripts are not enabled by default; a host or admin must enable them, and admins can configure automatic generation, viewing/saving permissions, and deletion. Zoom documents Pro, Business, or Enterprise requirements for the account setting. [Using Meeting transcripts](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0085682), [enabling and retaining Meeting transcripts](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0085675), [May 2026 transcript changes](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0085668).

For retrieval, Zoom exposes `GET /meetings/{meetingId}/transcript`, which returns readiness plus an OAuth-protected `download_url`; a `NOT_READY` reason allows polling until processing completes. The documented granular scopes include `cloud_recording:read:meeting_transcript` and its admin variant. Because this endpoint remains categorized under Cloud Recording in parts of Zoom's API documentation, validate standalone Meeting transcript retrieval with the target Zoom account during integration testing. [Zoom Meetings API](https://developers.zoom.us/docs/api/meetings/).

Latency is real time inside the Zoom client, but programmatic post-meeting readiness has no fixed SLA in the cited API. This makes the native artifact path appropriate for asynchronous notes, not a guaranteed live copilot.

### B. Zoom RTMS for live transcription

Zoom Real-Time Media Streams (RTMS) delivers live meeting/webinar media to an authorized application without making the application join as a participant bot. A backend can feed the audio stream into streaming ASR, diarization, and summarization, then show notes with low latency. It avoids the visual bot and avoids requiring a Zoom cloud recording, but requires RTMS app/configuration support and the relevant host/admin/in-meeting authorization. [Zoom RTMS documentation](https://developers.zoom.us/docs/rtms/).

RTMS is the strongest Zoom option when we need live output or our own speech model. It is also more engineering-intensive: reconnects, ordering, partial/final ASR segments, audio retention, diarization, and participant identity mapping become our responsibility.

### C. Cloud-recording transcript fallback

The older, well-established path records the meeting to Zoom Cloud and generates a timestamped VTT afterward. It requires a Pro, Business, Education, or Enterprise account, cloud recording, and audio transcription. The transcript may require additional processing after the recording becomes available, and Zoom supports an editable `Unknown Speaker` label, so identity is not guaranteed. [Using audio transcription for cloud recordings](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064927).

The API can return `TRANSCRIPT` recording files, and an integration can use transcript/recording completion webhooks before downloading with OAuth. [Zoom Meetings API](https://developers.zoom.us/docs/api/meetings/), [Zoom meeting webhooks](https://developers.zoom.us/docs/api/meetings/events/), [webhook scopes and delivery](https://developers.zoom.us/docs/api/webhooks/).

Zoom always gives participants a recording notification; client participants see a disclaimer and phone participants hear an audio prompt. Account type affects which internal notices can be customized, while guest notification remains required. [Zoom recording notifications](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0068228).

## Microsoft Teams

Teams native live transcription can run without recording. It appears in real time with the speaker's name and timestamp. Organizer/admin policy and meeting options control who can start it; people outside the organizer's tenant generally cannot start it or access it after the meeting. Everyone is notified when transcription begins. [Start, stop, and download Teams transcripts](https://support.microsoft.com/en-us/teams/meetings/start-stop-and-download-live-transcripts-in-microsoft-teams-meetings), [Teams recording/transcription controls](https://support.microsoft.com/en-US/teams/meetings/i-can-t-record-a-meeting-in-microsoft-teams).

For an integration:

- Subscribe to Graph transcript change notifications **before transcription starts**; Microsoft says a notification is sent when the transcript is available after an online meeting or ad-hoc call. Private-channel meeting notifications are not currently supported. [Graph transcript change notifications](https://learn.microsoft.com/en-us/graph/teams-changenotifications-callrecording-and-calltranscript).
- List/get the `callTranscript` artifact and fetch `/content`. Scheduled meetings are supported except live events; the list API does not support standalone meetings created by `create onlineMeeting` without an associated calendar event, and artifacts are unavailable after the meeting expires. [List online-meeting transcripts](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-list-transcripts?view=graph-rest-1.0).
- Request WebVTT for timestamped utterances with `<v Speaker>` tags. Speaker attribution is governed by tenant settings; Microsoft also documents an unattributed timestamped format. [Get transcript content](https://learn.microsoft.com/en-us/graph/api/calltranscript-get?view=graph-rest-1.0).
- Use the least-privileged applicable Graph permission: delegated/application `OnlineMeetingTranscript.Read.All`, or resource-specific consent `OnlineMeetingTranscript.Read.Chat` for applicable scheduled private-chat meetings. Application access can require a Teams application access policy, and tenant administrators can disable Graph transcript access independently of OAuth consent. [List transcript permissions](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-list-transcripts?view=graph-rest-1.0), [Teams transcript integration overview](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/meeting-transcripts/overview-transcripts).

This is a strong no-bot path for organizations willing to approve an Entra/Teams integration. It is less dependable for cross-tenant sales calls where our user is not the organizer and the customer's tenant disallows transcription or API access.

## Google Meet

Google Meet transcription is independent of recording. Eligible Workspace editions can start or preconfigure transcription; with Host management enabled, only the host/co-host can start it. Everyone sees the transcript indicator, and an administrator can require explicit consent. The transcript is saved in the organizer's Drive; supported editions/languages and Drive-capacity requirements apply. [Use Transcripts with Google Meet](https://support.google.com/meet/answer/12849897?hl=en-AG), [configure automatic artifacts](https://developers.google.com/workspace/meet/api/guides/meeting-spaces-configuration).

The Meet REST API provides the best structured artifact of the three providers:

- `conferenceRecords.transcripts` exposes lifecycle states such as `STARTED`, `ENDED`, and `FILE_GENERATED` plus the Docs destination. [Transcript resource](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts).
- `conferenceRecords.transcripts.entries.list` returns chronological entries with text, language, start/end timestamps, and a participant reference; participant APIs resolve that reference to identity/display details. Transcript entry API data is retained for 30 days, while the Drive artifact follows Drive/Vault retention. [Work with Meet artifacts](https://developers.google.com/workspace/meet/api/guides/artifacts), [list transcript entries](https://developers.google.com/workspace/meet/api/reference/rest/v2/conferenceRecords.transcripts.entries/list).
- Subscribe to `google.workspace.meet.transcript.v2.fileGenerated` rather than polling continuously. [Subscribe to Meet events](https://developers.google.com/workspace/events/guides/events-meet).

The structured API uses sensitive `meetings.space.readonly` (or the narrower created-space scope where applicable). Downloading the Google Docs/Drive file requires a restricted Drive scope; avoiding that download and using transcript entries reduces consent and verification burden. Domain-wide delegation is possible for Workspace administrators. [Meet authentication and scopes](https://developers.google.com/workspace/meet/api/guides/authenticate-authorize).

Google says artifacts are generally ready soon after the conference ends, but publishes no fixed SLA; use the file-generated event and represent the transcript as `processing` until it arrives.

## Participant-side local audio capture

This fallback does not depend on provider APIs and does not create a meeting attendee.

### Browser extension

For meetings running in a browser tab, a Chrome extension can use `chrome.tabCapture` to obtain the current tab's audio stream after the user explicitly invokes the extension. Capture the microphone separately, keep it as a distinct track, and send both streams to streaming ASR or record chunks for post-call ASR. Keeping the microphone separate gives deterministic attribution for the local user; the remote tab audio is still a mix and needs diarization. Chrome documents that tab capture requires a user invocation and that captured tab audio may need to be reconnected to an `AudioContext` so the user continues hearing it. [Chrome `tabCapture`](https://developer.chrome.com/docs/extensions/reference/api/tabCapture), [Chrome audio/screen capture guide](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture).

A normal web application can request display/tab audio with `getDisplayMedia`, but the browser must prompt every time, the user chooses the surface, permission cannot be persisted, and an audio track is not guaranteed even when requested. The Screen Capture specification also requires active consent for system audio and privacy indicators. [W3C Screen Capture specification](https://www.w3.org/TR/screen-capture/).

### Desktop application

- On macOS, ScreenCaptureKit can capture application/system audio and microphone samples as separate stream output types, which is preferable to recording the entire display. [Apple ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos), [ScreenCaptureKit updates](https://developer.apple.com/documentation/Updates/ScreenCaptureKit).
- On Windows, WASAPI loopback captures the audio rendered to an output endpoint; process loopback can restrict capture to a selected process and its children. Capture the microphone separately. [WASAPI loopback recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording), [application loopback sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/).

Local capture is viable for a cross-platform fallback, but it has important limitations:

- The remote side is usually one mixed track, so AI diarization yields `Speaker 1/2`, not authoritative participant identities. Names can only be inferred from meeting metadata and voice timing, and should be exposed as editable, confidence-scored labels.
- Headsets make system/loopback capture cleaner; speaker playback can leak into the microphone and create duplicates unless echo cancellation and track-aware reconciliation are applied.
- Browser/OS permissions, sleep, device changes, Bluetooth transitions, and app restarts can silently interrupt a long capture; the recorder needs visible health indicators and chunked uploads.
- Capturing all system audio can include unrelated notifications or applications. Prefer tab/process-scoped audio and exclude the recorder's own output.
- Because provider recording banners may not appear for an independent recorder, the product must not imply that local capture is invisible or exempt from consent obligations.

## Consent, privacy, and security guardrails

Not legal advice; recording/transcription rules differ by jurisdiction, customer policy, and context. Product defaults should be conservative:

- Tell all participants clearly that transcription/AI processing is active, identify the service, state what is stored and why, and provide a practical opt-out/stop path. Do this even if a platform banner is also present.
- Respect organizer and tenant controls; do not attempt to bypass disabled transcription, artifact access, participant notices, or provider consent flows.
- Minimize collection: prefer provider transcript entries over raw audio/video; for streaming ASR, discard audio after transcription unless the customer explicitly selects retention.
- Encrypt transport and storage, isolate tenants, scope OAuth narrowly, audit transcript access/downloads, and support deletion and configurable retention.
- Treat transcripts, speaker identity, summaries, and inferred action items as sensitive and fallible. Preserve timestamps/source links, show AI uncertainty, and allow correction.
- Avoid using customer meeting content for model training by default; document subprocessors, data residency, and retention behavior.

## Practical rollout

1. Build the normalized transcript model and asynchronous pipeline around Google Meet and Teams native artifacts.
2. Add Zoom Meeting transcript retrieval and validate standalone transcript behavior across target Zoom account types; use the cloud-recording artifact as the mature fallback.
3. Add provider availability webhooks plus polling recovery/idempotency.
4. Add Zoom RTMS only if live notes are a product requirement.
5. Add a Chrome extension or desktop recorder only for unsupported/externally controlled meetings, with explicit consent UX and capture-health monitoring.

The best initial promise is therefore **"no meeting bot; transcript appears shortly after calls where native transcription is enabled."** Real-time, works-everywhere transcription is possible, but requires RTMS or participant-side media capture and materially more engineering and privacy work.
