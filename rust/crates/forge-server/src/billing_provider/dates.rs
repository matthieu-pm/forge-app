//! The provider's pending-change dates use JavaScript Date coercion, unlike the
//! strict ISO payment evidence validator. Zone-less provider dates use UTC.
use chrono::{DateTime, Datelike, NaiveDate, Utc};
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

const TIME_CLIP: i64 = 8_640_000_000_000_000;
const DAY_MILLIS: i64 = 86_400_000;

/// A valid JavaScript Date, whose range exceeds chrono's calendar range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct JsDate(i64);

impl JsDate {
    pub fn from_timestamp_millis(value: i64) -> Option<Self> {
        (-TIME_CLIP..=TIME_CLIP)
            .contains(&value)
            .then_some(Self(value))
    }
    pub fn timestamp_millis(self) -> i64 {
        self.0
    }
    /// Calendar consumers must explicitly handle chrono's narrower range.
    pub fn to_datetime(self) -> Option<DateTime<Utc>> {
        DateTime::from_timestamp_millis(self.0)
    }
    /// ECMAScript Date.toISOString, including signed six-digit extended years.
    pub fn to_iso_string(self) -> String {
        let days = self.0.div_euclid(DAY_MILLIS);
        let time = self.0.rem_euclid(DAY_MILLIS);
        let (year, month, day) = civil_from_days(days);
        let year = if (0..=9999).contains(&year) {
            format!("{year:04}")
        } else if year < 0 {
            format!("-{:06}", -year)
        } else {
            format!("+{year:06}")
        };
        let hour = time / 3_600_000;
        let minute = time / 60_000 % 60;
        let second = time / 1000 % 60;
        let millis = time % 1000;
        format!("{year}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
    }
}

static ISO: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^([+-][0-9]{6}|[0-9]{4})(?:-([0-9]{2})(?:-([0-9]{2}))?)?(?:[t ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]+))?)?(z|[+-][0-9]{2}:?[0-9]{2})?|z)?$").unwrap()
});
static NUMERIC_LEGACY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([0-9]+)[/,]([0-9]+)[/,]([0-9]+)$").unwrap());

pub fn coerce_date(value: Option<&Value>) -> Option<JsDate> {
    match value? {
        Value::Null => JsDate::from_timestamp_millis(0),
        Value::Bool(value) => JsDate::from_timestamp_millis(i64::from(*value)),
        Value::Number(value) => {
            let number = value.as_f64()?;
            if !number.is_finite() || number.abs() > TIME_CLIP as f64 {
                return None;
            }
            JsDate::from_timestamp_millis(number.trunc() as i64)
        }
        Value::String(value) => parse(value),
        Value::Array(values) => parse(
            &values
                .iter()
                .map(array_string)
                .collect::<Vec<_>>()
                .join(","),
        ),
        Value::Object(_) => None,
    }
}
fn array_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(value) => value.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(values) => values
            .iter()
            .map(array_string)
            .collect::<Vec<_>>()
            .join(","),
        _ => forge_core::canonical::javascript_stringify(value),
    }
}
fn parse(input: &str) -> Option<JsDate> {
    let raw = forge_core::text::trim(input);
    if let Some(parts) = ISO.captures(raw) {
        // V8 permits surrounding whitespace for legacy/date-only forms, but
        // rejects it once the ISO T time separator is present.
        if (input != raw && raw.contains(['T', 't'])) || &parts[1] == "-000000" {
            return None;
        }
        let year: i64 = parts[1].parse().ok()?;
        let number = |index: usize, default: u32| -> Option<u32> {
            parts
                .get(index)
                .map_or(Some(default), |part| part.as_str().parse().ok())
        };
        let month = number(2, 1)?;
        let day = number(3, 1)?;
        let hour = number(4, 0)?;
        let minute = number(5, 0)?;
        let second = number(6, 0)?;
        let fraction = parts.get(7).map(|part| part.as_str()).unwrap_or("");
        let millis = format!("{fraction:0<3}").get(..3)?.parse::<u32>().ok()?;
        if !(1..=12).contains(&month)
            || !(1..=31).contains(&day)
            || hour > 24
            || minute > 59
            || second > 59
            || (hour == 24 && (minute != 0 || second != 0 || fraction.bytes().any(|c| c != b'0')))
            || (parts.get(4).is_some() && parts.get(3).is_none())
        {
            return None;
        }
        let zone = parts.get(8).map(|part| part.as_str()).unwrap_or("Z");
        let offset = if zone.eq_ignore_ascii_case("z") {
            0
        } else {
            let digits = zone[1..].replace(':', "");
            let hours: i64 = digits[..2].parse().ok()?;
            let minutes: i64 = digits[2..].parse().ok()?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            (hours * 60 + minutes) * if zone.starts_with('-') { -1 } else { 1 }
        };
        let time = i64::from(hour) * 3_600_000
            + i64::from(minute) * 60_000
            + i64::from(second) * 1000
            + i64::from(millis);
        return JsDate::from_timestamp_millis(
            days_from_civil(year, month, day) * DAY_MILLIS + time - offset * 60_000,
        );
    }
    if let Ok(date) = DateTime::parse_from_rfc2822(raw) {
        return JsDate::from_timestamp_millis(date.timestamp_millis());
    }
    if let Some(parts) = NUMERIC_LEGACY.captures(raw) {
        let first: i64 = parts[1].parse().ok()?;
        let second: u32 = parts[2].parse().ok()?;
        let third: i64 = parts[3].parse().ok()?;
        let (year, month, day) = if first > 31 {
            (first, second, u32::try_from(third).ok()?)
        } else {
            let year = match third {
                0..=49 => third + 2000,
                50..=99 => third + 1900,
                _ => third,
            };
            (year, u32::try_from(first).ok()?, second)
        };
        return calendar_date(year, month, day);
    }
    for format in ["%b %d %Y", "%B %d %Y"] {
        if let Ok(date) = NaiveDate::parse_from_str(raw, format) {
            return calendar_date(i64::from(date.year()), date.month(), date.day());
        }
    }
    // V8's legacy numeric strings denote a month, a two-digit year, or a year.
    if !raw.is_empty() && raw.bytes().all(|byte| byte.is_ascii_digit()) {
        let number: i64 = raw.parse().ok()?;
        let (year, month) = match number {
            0 => (2000, 1),
            1..=12 => (2001, number as u32),
            32..=49 => (2000 + number, 1),
            50..=99 => (1900 + number, 1),
            100.. => (number, 1),
            _ => return None,
        };
        return calendar_date(year, month, 1);
    }
    None
}
fn calendar_date(year: i64, month: u32, day: u32) -> Option<JsDate> {
    // Bound before civil arithmetic; TimeClip rejects every date outside this
    // year interval. Days 29..31 intentionally roll over short months like V8.
    if !(-271821..=275760).contains(&year) || !(1..=12).contains(&month) || !(1..=31).contains(&day)
    {
        return None;
    }
    JsDate::from_timestamp_millis(days_from_civil(year, month, day) * DAY_MILLIS)
}
// Proleptic Gregorian conversion uses Euclidean eras, including year zero and
// negative years. It does not impose chrono's narrower supported year range.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146097 + day_of_era - 719468
}
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719468;
    let era = days.div_euclid(146097);
    let day_of_era = days - era * 146097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month + 2) / 5 + 1;
    let month = month + if month < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}
