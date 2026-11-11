//! Inclusive calendar windows in the team's stored timezone.
pub use crate::contract::ContractError as CycleError;
use crate::contract::*;
use chrono::{DateTime, Datelike, Days, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashMap, sync::OnceLock};
pub fn timezone(v: Value) -> Result<Value> {
    let v = text(v, 0, 100, false)?;
    static ZONES: OnceLock<HashMap<String, String>> = OnceLock::new();
    let zones = ZONES.get_or_init(|| {
        serde_json::from_str(include_str!("../data/cycle-timezones.json"))
            .expect("reference timezones")
    });
    zones
        .get(&v.as_str().unwrap().to_ascii_lowercase())
        .map(|s| json!(s))
        .ok_or(ContractError("timezone"))
}
pub fn initial() -> Value {
    json!({"enabled":false,"duration":2,"cooldown":2,"startDay":1,"futureCycles":2,"activeIssues":false,"startedIssues":true,"completedIssues":true})
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(try_from = "Value", into = "Value")]
pub struct Settings(Value);
impl TryFrom<Value> for Settings {
    type Error = CycleError;
    fn try_from(v: Value) -> Result<Self> {
        Self::parse(v)
    }
}
impl From<Settings> for Value {
    fn from(v: Settings) -> Self {
        v.0
    }
}
impl Settings {
    pub fn parse(v: Value) -> Result<Self> {
        let mut o = Object::new(
            v,
            &[
                "enabled",
                "timezone",
                "duration",
                "cooldown",
                "startDay",
                "futureCycles",
                "activeIssues",
                "startedIssues",
                "completedIssues",
            ],
            false,
        )?;
        for key in [
            "enabled",
            "activeIssues",
            "startedIssues",
            "completedIssues",
        ] {
            o.required(key, boolean)?;
        }
        o.optional("timezone", timezone)?;
        for (key, min, max) in [
            ("duration", 1., 8.),
            ("cooldown", 0., 4.),
            ("startDay", 0., 6.),
            ("futureCycles", 1., 6.),
        ] {
            o.required(key, |v| number(v, min, max, true))?;
        }
        Ok(Self(o.finish()))
    }
    pub fn as_value(&self) -> &Value {
        &self.0
    }
    pub fn into_value(self) -> Value {
        self.0
    }
}
pub fn triage(v: Value) -> Result<Value> {
    let mut o = Object::new(v, &["enabled", "requirePriority", "action"], false)?;
    o.required("enabled", boolean)?;
    o.required("requirePriority", boolean)?;
    o.optional("action", |v| enumeration(v, &["none", "notify", "assign"]))?;
    Ok(o.finish())
}
pub fn today(zone: &str, now: DateTime<Utc>) -> Result<String> {
    let canonical = timezone(json!(zone))?;
    let zone = crate::timezones::Zone::parse(canonical.as_str().unwrap())?;
    Ok(zone.local(now)?.format("%Y-%m-%d").to_string())
}
fn day(value: &str) -> Result<NaiveDate> {
    date(json!(value))?;
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| ContractError("calendar date"))
}
pub fn add_days(value: &str, days: i64) -> Result<String> {
    let day = day(value)?;
    let result = if days >= 0 {
        day.checked_add_days(Days::new(days as u64))
    } else {
        day.checked_sub_days(Days::new(days.unsigned_abs()))
    }
    .ok_or(ContractError("calendar range"))?;
    if !(0..=9999).contains(&result.year()) {
        return Err(ContractError("calendar range"));
    }
    Ok(result.format("%Y-%m-%d").to_string())
}
pub fn next_date(value: &str, weekday: u32, strict: bool) -> Result<String> {
    if weekday > 6 {
        return Err(ContractError("weekday"));
    }
    let delta = (weekday + 7 - day(value)?.weekday().num_days_from_sunday()) % 7;
    add_days(
        value,
        if delta == 0 && strict {
            7
        } else {
            i64::from(delta)
        },
    )
}
pub fn scheduled_dates(
    settings: &Settings,
    zone: &str,
    last_end: Option<&str>,
    future: usize,
    now: DateTime<Utc>,
) -> Result<Vec<(String, String)>> {
    let settings = settings.as_value();
    if settings["enabled"] != true {
        return Ok(vec![]);
    }
    let today = today(zone, now)?;
    let weekday = settings["startDay"].as_u64().unwrap() as u32;
    let cooldown = settings["cooldown"].as_i64().unwrap() * 7 + 1;
    let mut next = if let Some(last) = last_end {
        next_date(&add_days(last, cooldown)?, weekday, false)?
    } else {
        next_date(&today, weekday, true)?
    };
    if next <= today {
        next = next_date(&today, weekday, true)?;
    }
    let mut windows = vec![];
    for _ in future..settings["futureCycles"].as_u64().unwrap() as usize {
        let end = add_days(&next, settings["duration"].as_i64().unwrap() * 7 - 1)?;
        windows.push((next, end.clone()));
        next = add_days(&end, cooldown)?;
    }
    Ok(windows)
}
pub fn settings_command(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &["teamId", "kind", "commandKey", "expectedRevision", "value"],
        true,
    )?;
    o.required("teamId", uuid)?;
    o.required("commandKey", uuid)?;
    o.required("expectedRevision", integer)?;
    o.required("kind", |v| enumeration(v, &["cycles", "triage"]))?;
    o.required("value", |v| nullable(v, |v| text(v, 0, 20_000_000, false)))?;
    let value = o.finish();
    if let Some(raw) = value["value"].as_str() {
        let raw: Value = serde_json::from_str(raw).map_err(|_| ContractError("settings JSON"))?;
        if value["kind"] == "cycles" {
            Settings::parse(raw)?;
        } else {
            triage(raw)?;
        }
    }
    Ok(value)
}
