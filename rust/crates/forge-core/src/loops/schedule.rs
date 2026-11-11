use crate::contract::*;
use chrono::{DateTime, Datelike, Duration, NaiveDate, Timelike, Utc};
use serde_json::{Value, json};

use crate::timezones::Zone;
impl Zone {
    fn parts(&self, date: DateTime<Utc>) -> Result<Parts> {
        let local = self.local(date)?;
        Ok(Parts {
            // Intl uses the Gregorian era year, including for year zero.
            year: if local.year() > 0 {
                local.year()
            } else {
                1 - local.year()
            },
            month: local.month(),
            day: local.day(),
            hour: local.hour(),
            minute: local.minute(),
            second: local.second(),
        })
    }
}
pub(super) fn contract(v: Value) -> Result<Value> {
    let mut o = Object::new(
        v,
        &[
            "kind", "unit", "interval", "startAt", "timeZone", "weekdays",
        ],
        true,
    )?;
    o.required("unit", |v| {
        enumeration(v, &["hours", "days", "weeks", "months", "years"])
    })?;
    o.required("interval", |v| number(v, 1., 1000., true))?;
    o.required("startAt", datetime)?;
    o.required("timeZone", |v| {
        let v = text(v, 1, 100, false)?;
        Zone::parse(v.as_str().unwrap())?;
        Ok(v)
    })?;
    o.optional("weekdays", |v| list(v, 1, 7, |v| number(v, 1., 7., true)))?;
    let v = o.finish();
    if v["unit"] == "weeks" {
        let days = v["weekdays"].as_array().ok_or(ContractError("weekdays"))?;
        if days.iter().enumerate().any(|(i, d)| days[..i].contains(d)) {
            return Err(ContractError("unique weekdays"));
        }
    } else if v.get("weekdays").is_some() {
        return Err(ContractError("weekly schedule"));
    }
    Ok(v)
}
fn parse_start(value: &str) -> Result<DateTime<Utc>> {
    // The scheduling function accepts Date-compatible minute precision even
    // though its published Zod contract requires seconds. JS retains only ms.
    pattern(
        json!(value),
        r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-5][0-9](?:\.[0-9]+)?)?Z$",
    )?;
    let number = |a: usize, b: usize| {
        value[a..b]
            .parse::<u32>()
            .map_err(|_| ContractError("schedule date"))
    };
    let year = number(0, 4)? as i32;
    let date = NaiveDate::from_ymd_opt(year, number(5, 7)?, number(8, 10)?)
        .ok_or(ContractError("schedule date"))?;
    let second = if value.as_bytes()[16] == b':' {
        number(17, 19)?
    } else {
        0
    };
    let millis = value
        .split_once('.')
        .map(|(_, digits)| {
            let digits = digits.trim_end_matches('Z');
            let first = &digits[..digits.len().min(3)];
            format!("{first:0<3}").parse::<u32>().unwrap_or(0)
        })
        .unwrap_or(0);
    date.and_hms_milli_opt(number(11, 13)?, number(14, 16)?, second, millis)
        .map(|d| d.and_utc())
        .ok_or(ContractError("schedule date"))
}
#[derive(Clone, Copy)]
struct Parts {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
}
impl Parts {
    fn date(self) -> Result<NaiveDate> {
        // Match Date.UTC's historical 0..99 year convention.
        let year = if (0..=99).contains(&self.year) {
            self.year + 1900
        } else {
            self.year
        };
        NaiveDate::from_ymd_opt(year, self.month, self.day).ok_or(ContractError("schedule range"))
    }
    fn stamp(self) -> Result<DateTime<Utc>> {
        self.date()?
            .and_hms_opt(self.hour, self.minute, self.second)
            .map(|d| d.and_utc())
            .ok_or(ContractError("schedule date"))
    }
    fn calendar(self, days: i64) -> Result<Self> {
        let day = self
            .date()?
            .checked_add_signed(Duration::try_days(days).ok_or(ContractError("schedule range"))?)
            .ok_or(ContractError("schedule range"))?;
        Ok(Self {
            year: day.year(),
            month: day.month(),
            day: day.day(),
            ..self
        })
    }
}
fn add(date: DateTime<Utc>, duration: Duration) -> Result<DateTime<Utc>> {
    date.checked_add_signed(duration)
        .ok_or(ContractError("schedule range"))
}
fn instant(local: Parts, zone: &Zone) -> Result<DateTime<Utc>> {
    // Probe both sides of a transition. A nonexistent local time moves forward;
    // a repeated local time selects the earlier occurrence exactly once.
    let target = local.stamp()?;
    let mut guesses = Vec::with_capacity(3);
    for hours in [-36, 0, 36] {
        let probe = add(target, Duration::hours(hours))?;
        guesses.push(add(target, probe - zone.parts(probe)?.stamp()?)?);
    }
    let mut exact = Vec::new();
    let mut later = Vec::new();
    for &candidate in &guesses {
        let stamp = zone.parts(candidate)?.stamp()?;
        if stamp == target {
            exact.push(candidate);
        }
        if stamp > target {
            later.push(candidate);
        }
    }
    Ok(*if !exact.is_empty() {
        &exact
    } else if !later.is_empty() {
        &later
    } else {
        &guesses
    }
    .iter()
    .min()
    .unwrap())
}
/// The first occurrence strictly after `after`, anchored to the original start.
/// Missed ticks coalesce; calendar schedules preserve wall time across DST.
pub fn next_scheduled_at(schedule: &Value, after: DateTime<Utc>) -> Result<DateTime<Utc>> {
    if schedule["kind"] != "schedule" {
        return Err(ContractError("schedule"));
    }
    let start = parse_start(
        schedule["startAt"]
            .as_str()
            .ok_or(ContractError("schedule date"))?,
    )?;
    let after = DateTime::from_timestamp_millis(after.timestamp_millis())
        .ok_or(ContractError("schedule date"))?;
    let interval = number(schedule["interval"].clone(), 1., 1000., true)?
        .as_i64()
        .unwrap();
    let unit = schedule["unit"]
        .as_str()
        .filter(|u| ["hours", "days", "weeks", "months", "years"].contains(u))
        .ok_or(ContractError("schedule unit"))?;
    if unit == "hours" {
        let step = interval * 3_600_000;
        let ordinal =
            ((after.timestamp_millis() - start.timestamp_millis()).div_euclid(step) + 1).max(0);
        let millis = ordinal
            .checked_mul(step)
            .ok_or(ContractError("schedule range"))?;
        return add(start, Duration::milliseconds(millis));
    }
    let zone = Zone::parse(
        schedule["timeZone"]
            .as_str()
            .ok_or(ContractError("timezone"))?,
    )?;
    let anchor = zone.parts(start)?;
    let current = zone.parts(after)?;
    let acceptable = |date: DateTime<Utc>| date >= start && date > after;
    if unit == "days" {
        let elapsed = (current.date()? - anchor.date()?).num_days();
        let mut ordinal = elapsed.div_euclid(interval).max(0);
        loop {
            let result = instant(anchor.calendar(ordinal * interval)?, &zone)?;
            if acceptable(result) {
                return Ok(result);
            }
            ordinal += 1;
        }
    }
    if unit == "weeks" {
        let monday =
            anchor.calendar(-i64::from(anchor.date()?.weekday().num_days_from_monday()))?;
        let elapsed = (current.date()? - monday.date()?).num_days().div_euclid(7);
        let mut ordinal = elapsed.div_euclid(interval).max(0);
        let weekdays = list(schedule["weekdays"].clone(), 1, 7, |v| {
            number(v, 1., 7., true)
        })?;
        let mut weekdays = weekdays
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d.as_i64().unwrap())
            .collect::<Vec<_>>();
        weekdays.sort();
        loop {
            for day in &weekdays {
                let result = instant(monday.calendar(ordinal * interval * 7 + day - 1)?, &zone)?;
                if acceptable(result) {
                    return Ok(result);
                }
            }
            ordinal += 1;
        }
    }
    let month_step = interval * if unit == "years" { 12 } else { 1 };
    let elapsed = i64::from(current.year - anchor.year) * 12 + i64::from(current.month)
        - i64::from(anchor.month);
    let mut ordinal = elapsed.div_euclid(month_step).max(0);
    loop {
        let index =
            i64::from(anchor.year) * 12 + i64::from(anchor.month) - 1 + ordinal * month_step;
        let year =
            i32::try_from(index.div_euclid(12)).map_err(|_| ContractError("schedule range"))?;
        let month = index.rem_euclid(12) as u32 + 1;
        let next_month = NaiveDate::from_ymd_opt(
            year + i32::from(month == 12),
            if month == 12 { 1 } else { month + 1 },
            1,
        )
        .ok_or(ContractError("schedule range"))?;
        let last_day = next_month
            .pred_opt()
            .ok_or(ContractError("schedule range"))?
            .day();
        let result = instant(
            Parts {
                year,
                month,
                day: anchor.day.min(last_day),
                ..anchor
            },
            &zone,
        )?;
        if acceptable(result) {
            return Ok(result);
        }
        ordinal += 1;
    }
}
pub fn local_date_time(date: DateTime<Utc>, time_zone: &str) -> Result<String> {
    let p = Zone::parse(time_zone)?.parts(date)?;
    Ok(format!(
        "{}-{:02}-{:02}T{:02}:{:02}",
        p.year, p.month, p.day, p.hour, p.minute
    ))
}
pub fn schedule_start(local: &str, time_zone: &str) -> std::result::Result<String, &'static str> {
    const ERROR: &str = "Choose a valid first run date and time.";
    pattern(
        json!(local),
        r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$",
    )
    .map_err(|_| ERROR)?;
    let n = |a: usize, b: usize| local[a..b].parse::<u32>().map_err(|_| ERROR);
    let p = Parts {
        year: n(0, 4)? as i32,
        month: n(5, 7)?,
        day: n(8, 10)?,
        hour: n(11, 13)?,
        minute: n(14, 16)?,
        second: 0,
    };
    if p.year < 1000 || p.year > 9999 {
        return Err(ERROR);
    }
    let zone = Zone::parse(time_zone).map_err(|_| ERROR)?;
    instant(p, &zone).map(iso_timestamp).map_err(|_| ERROR)
}
/// Date.toISOString uses signed six-digit years outside 0000..9999.
pub fn iso_timestamp(date: DateTime<Utc>) -> String {
    if (0..=9999).contains(&date.year()) {
        return date.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    }
    format!(
        "{}{:06}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        if date.year() < 0 { "-" } else { "+" },
        date.year().unsigned_abs(),
        date.month(),
        date.day(),
        date.hour(),
        date.minute(),
        date.second(),
        date.timestamp_subsec_millis()
    )
}
