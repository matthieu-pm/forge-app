use super::*;
use chrono::{DateTime, SecondsFormat, Utc};
use forge_core::calls::{parse_transcript, providers::NativeCall};
use url::Url;
pub(super) fn allowed(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    let host = url.host_str().unwrap_or("");
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && ([
            "meet.googleapis.com",
            "graph.microsoft.com",
            "api.zoom.us",
            "zoom.us",
        ]
        .contains(&host)
            || host.ends_with(".zoom.us"))
}
fn component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
fn stamp(date: DateTime<Utc>) -> String {
    date.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn date(value: &Value) -> Result<DateTime<Utc>, Error> {
    DateTime::parse_from_rfc3339(value.as_str().ok_or(Error)?)
        .map(|d| d.with_timezone(&Utc))
        .map_err(|_| Error)
}
fn utc(value: &Value) -> Result<DateTime<Utc>, Error> {
    let raw = value.as_str().ok_or(Error)?;
    if let Ok(date) = DateTime::parse_from_rfc3339(raw) {
        return Ok(date.with_timezone(&Utc));
    }
    DateTime::parse_from_rfc3339(&format!("{raw}Z"))
        .map(|d| d.with_timezone(&Utc))
        .map_err(|_| Error)
}
fn list(value: &Value, key: &str) -> Result<Vec<Value>, Error> {
    match value.get(key).filter(|v| !v.is_null()) {
        None => Ok(vec![]),
        Some(v) => v.as_array().cloned().ok_or(Error),
    }
}
fn required<'a>(value: &'a Value, key: &str) -> Result<&'a str, Error> {
    value[key].as_str().ok_or(Error)
}
fn minutes(start: DateTime<Utc>, end: DateTime<Utc>) -> Result<i32, Error> {
    let value = ((end - start).num_milliseconds() as f64 / 60000. + 0.5).floor();
    if value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
        return Err(Error);
    }
    Ok(value as i32)
}
impl Client {
    async fn api_text(&self, url: &str, token: &str) -> Result<String, Error> {
        if !allowed(url) {
            return Err(Error);
        }
        let text = self.transport.read(url, token).await?;
        if text.encode_utf16().count() > 2_000_000 {
            return Err(Error);
        }
        Ok(text)
    }
    async fn api(&self, url: &str, token: &str) -> Result<Value, Error> {
        forge_core::json::parse(&self.api_text(url, token).await?).map_err(|_| Error)
    }
    async fn pages(
        &self,
        url: String,
        token: &str,
        key: &str,
        mode: &str,
    ) -> Result<Vec<Value>, Error> {
        let mut result = vec![];
        let mut next = url.clone();
        for _ in 0..100 {
            if next.is_empty() {
                return Ok(result);
            }
            let data = self.api(&next, token).await?;
            result.extend(list(&data, key)?);
            if mode == "teams" {
                next = data["@odata.nextLink"].as_str().unwrap_or("").into();
            } else {
                let cursor = data
                    .get("nextPageToken")
                    .filter(|v| !v.is_null())
                    .or_else(|| data.get("next_page_token"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if cursor.is_empty() {
                    next.clear();
                } else {
                    let mut parsed = Url::parse(&url).map_err(|_| Error)?;
                    let pairs: Vec<_> = parsed.query_pairs().into_owned().collect();
                    parsed.set_query(None);
                    parsed.query_pairs_mut().extend_pairs(pairs).append_pair(
                        if mode == "zoom" {
                            "next_page_token"
                        } else {
                            "pageToken"
                        },
                        cursor,
                    );
                    next = parsed.into();
                }
            }
        }
        if next.is_empty() {
            Ok(result)
        } else {
            Err(Error)
        }
    }
}
pub(super) async fn fetch(
    client: &Client,
    provider: &str,
    token: &str,
    since: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Result<Vec<NativeCall>, Error> {
    let mut calls = vec![];
    if provider == "google" {
        let base = "https://meet.googleapis.com/v2/";
        let filter = component(&format!("start_time >= \"{}\"", stamp(since)));
        for record in client
            .pages(
                format!("{base}conferenceRecords?filter={filter}&pageSize=100"),
                token,
                "conferenceRecords",
                "google",
            )
            .await?
        {
            if record["endTime"].as_str().is_none_or(str::is_empty) {
                continue;
            }
            let name = required(&record, "name")?;
            let transcripts = client
                .pages(
                    format!("{base}{name}/transcripts?pageSize=100"),
                    token,
                    "transcripts",
                    "google",
                )
                .await?;
            if transcripts.is_empty() || transcripts.iter().any(|v| v["state"] != "FILE_GENERATED")
            {
                continue;
            }
            let people = client
                .pages(
                    format!("{base}{name}/participants?pageSize=100"),
                    token,
                    "participants",
                    "google",
                )
                .await?;
            // Source Map replaces duplicate keys without changing insertion order.
            let mut names: Vec<(String, String)> = vec![];
            for p in people {
                let name = required(&p, "name")?.to_owned();
                let speaker = [
                    &p["signedinUser"]["displayName"],
                    &p["anonymousUser"]["displayName"],
                    &p["phoneUser"]["displayName"],
                ]
                .into_iter()
                .find_map(Value::as_str)
                .unwrap_or("Participant")
                .to_owned();
                if let Some((_, value)) = names.iter_mut().find(|(k, _)| *k == name) {
                    *value = speaker;
                } else {
                    names.push((name, speaker));
                }
            }
            let started = date(&record["startTime"])?;
            let mut entries = vec![];
            for transcript in transcripts {
                let name = required(&transcript, "name")?;
                for e in client
                    .pages(
                        format!("{base}{name}/entries?pageSize=100"),
                        token,
                        "transcriptEntries",
                        "google",
                    )
                    .await?
                {
                    let speaker = names
                        .iter()
                        .find(|(k, _)| Some(k.as_str()) == e["participant"].as_str())
                        .map(|(_, v)| v.as_str())
                        .unwrap_or("Participant");
                    entries.push(forge_core::calls::TranscriptEntry {
                        speaker: speaker.into(),
                        seconds: ((date(&e["startTime"])? - started).num_milliseconds() as f64
                            / 1000.)
                            .max(0.),
                        text: required(&e, "text")?.into(),
                    });
                }
            }
            entries.sort_by(|a, b| a.seconds.total_cmp(&b.seconds));
            calls.push(NativeCall {
                external_id: name.into(),
                title: format!(
                    "Meet · {}",
                    record["space"]
                        .as_str()
                        .map(|s| s.rsplit('/').next().unwrap_or(""))
                        .unwrap_or("Team conversation")
                ),
                started_at: started,
                duration: minutes(started, date(&record["endTime"])?)?,
                participants: names.into_iter().map(|(_, v)| v).collect(),
                transcript: entries,
            });
        }
    } else if provider == "teams" {
        let base = "https://graph.microsoft.com/v1.0";
        for event in client
            .pages(
                format!(
                    "{base}/me/calendarView?startDateTime={}&endDateTime={}&$top=100",
                    component(&stamp(since)),
                    component(&stamp(now))
                ),
                token,
                "value",
                "teams",
            )
            .await?
        {
            let Some(join) = event["onlineMeeting"]["joinUrl"]
                .as_str()
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            if event["isCancelled"] == true || event["isOrganizer"] == false {
                continue;
            }
            let filter = component(&format!("JoinWebUrl eq '{}'", join.replace('\'', "''")));
            let meetings = client
                .api(&format!("{base}/me/onlineMeetings?$filter={filter}"), token)
                .await?;
            for meeting in list(&meetings, "value")? {
                let meeting_id = required(&meeting, "id")?;
                let root = format!("{base}/me/onlineMeetings/{}", component(meeting_id));
                let transcripts = client
                    .pages(format!("{root}/transcripts"), token, "value", "teams")
                    .await?;
                let started = utc(&event["start"]["dateTime"])?;
                let ended = utc(&event["end"]["dateTime"])?;
                let mut entries = vec![];
                for t in transcripts {
                    let Ok(created) = date(&t["createdDateTime"]) else {
                        continue;
                    };
                    if created < started - chrono::Duration::minutes(1)
                        || created > ended + chrono::Duration::minutes(15)
                    {
                        continue;
                    }
                    let content = client
                        .api_text(
                            &format!(
                                "{root}/transcripts/{}/content?$format=text/vtt",
                                component(required(&t, "id")?)
                            ),
                            token,
                        )
                        .await?;
                    entries.extend(parse_transcript(&content));
                }
                if entries.is_empty() {
                    continue;
                }
                let mut participants = vec![];
                let mut names = vec![event["organizer"]["emailAddress"]["name"].clone()];
                names.extend(
                    list(&event, "attendees")?
                        .iter()
                        .map(|a| a["emailAddress"]["name"].clone()),
                );
                for name in names {
                    if let Some(name) = name.as_str().filter(|s| !s.is_empty())
                        && !participants.iter().any(|s| s == name)
                    {
                        participants.push(name.into());
                    }
                }
                calls.push(NativeCall {
                    external_id: format!("{meeting_id}:{}", required(&event, "id")?),
                    title: event["subject"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("Teams conversation")
                        .into(),
                    started_at: started,
                    duration: minutes(started, ended)?.max(0),
                    participants,
                    transcript: entries,
                });
            }
        }
    } else if provider == "zoom" {
        for meeting in client
            .pages(
                format!(
                    "https://api.zoom.us/v2/users/me/recordings?from={}&to={}&page_size=100",
                    since.format("%Y-%m-%d"),
                    now.format("%Y-%m-%d")
                ),
                token,
                "meetings",
                "zoom",
            )
            .await?
        {
            let mut entries = vec![];
            for file in list(&meeting, "recording_files")? {
                if file["recording_type"] == "audio_transcript" && file["status"] == "completed" {
                    entries.extend(parse_transcript(
                        &client
                            .api_text(required(&file, "download_url")?, token)
                            .await?,
                    ));
                }
            }
            if entries.is_empty() {
                continue;
            }
            let mut participants = vec![];
            for e in &entries {
                if !participants.contains(&e.speaker) {
                    participants.push(e.speaker.clone());
                }
            }
            let duration = match meeting.get("duration").filter(|v| !v.is_null()) {
                Some(v) => v
                    .as_f64()
                    .filter(|n| {
                        n.fract() == 0. && *n >= f64::from(i32::MIN) && *n <= f64::from(i32::MAX)
                    })
                    .map(|n| n as i32)
                    .ok_or(Error)?,
                None => 0,
            };
            calls.push(NativeCall {
                external_id: required(&meeting, "uuid")?.into(),
                title: meeting["topic"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Zoom conversation")
                    .into(),
                started_at: date(&meeting["start_time"])?,
                duration,
                participants,
                transcript: entries,
            });
        }
    } else {
        return Err(Error);
    }
    Ok(calls)
}
