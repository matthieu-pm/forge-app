//! Calendar offsets from bundled TZif rules, including Intl's legacy names.
use crate::contract::*;
use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveDateTime, Utc};
use serde_json::json;

pub(crate) enum Zone {
    Named(jiff::tz::TimeZone),
    Fixed(FixedOffset),
}
impl Zone {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        if value.starts_with(['+', '-']) {
            pattern(json!(value), r"^[+-][0-9]{2}(?::?[0-9]{2})?$")?;
            let digits = value[1..].replace(':', "");
            let hours = digits[..2]
                .parse::<i32>()
                .map_err(|_| ContractError("timezone"))?;
            let minutes = if digits.len() > 2 {
                digits[2..]
                    .parse::<i32>()
                    .map_err(|_| ContractError("timezone"))?
            } else {
                0
            };
            if hours > 23 || minutes > 59 {
                return Err(ContractError("timezone"));
            }
            return FixedOffset::east_opt(
                (hours * 3600 + minutes * 60) * if value.starts_with('-') { -1 } else { 1 },
            )
            .map(Self::Fixed)
            .ok_or(ContractError("timezone"));
        }
        let canonical = crate::cycles::timezone(json!(value))?;
        // ICU's canonical-timezone API identifies these legacy Intl spellings.
        // The source-generated calendar fixtures verify each accepted mapping.
        let name = match canonical.as_str().unwrap() {
            "ACT" => "Australia/Darwin",
            "AET" => "Australia/Sydney",
            "AGT" => "America/Buenos_Aires",
            "ART" => "Africa/Cairo",
            "AST" => "America/Anchorage",
            "BET" => "America/Sao_Paulo",
            "BST" => "Asia/Dhaka",
            "CAT" => "Africa/Maputo",
            "CNT" => "America/St_Johns",
            "CST" => "America/Chicago",
            "CTT" => "Asia/Shanghai",
            "EAT" => "Africa/Nairobi",
            "ECT" => "Europe/Paris",
            "EST" => "America/Panama",
            "HST" => "Pacific/Honolulu",
            "IET" => "America/Indianapolis",
            "IST" => "Asia/Calcutta",
            "JST" => "Asia/Tokyo",
            "MIT" => "Pacific/Apia",
            "MST" => "America/Phoenix",
            "NET" => "Asia/Yerevan",
            "NST" => "Pacific/Auckland",
            "PLT" => "Asia/Karachi",
            "PNT" => "America/Phoenix",
            "PRT" => "America/Puerto_Rico",
            "PST" => "America/Los_Angeles",
            "SST" => "Pacific/Guadalcanal",
            "VST" => "Asia/Saigon",
            name => name,
        };
        jiff::tz::TimeZone::get(name)
            .map(Self::Named)
            .map_err(|_| ContractError("timezone"))
    }
    pub(crate) fn local(&self, date: DateTime<Utc>) -> Result<NaiveDateTime> {
        let offset = match self {
            Self::Named(zone) => {
                // TZif's recurring rules continue beyond precomputed transitions.
                // Above Jiff's civil range, weekdays/leap years repeat every 400 years.
                let probe = if date.year() > 9998 {
                    date.with_year(2400 + date.year().rem_euclid(400))
                        .ok_or(ContractError("date range"))?
                } else {
                    date
                };
                let timestamp = jiff::Timestamp::from_second(probe.timestamp())
                    .map_err(|_| ContractError("date range"))?;
                zone.to_offset(timestamp).seconds()
            }
            Self::Fixed(zone) => zone.local_minus_utc(),
        };
        date.checked_add_signed(Duration::seconds(i64::from(offset)))
            .map(|d| d.naive_utc())
            .ok_or(ContractError("date range"))
    }
}
