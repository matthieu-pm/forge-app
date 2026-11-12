use super::*;
use chrono::{DateTime, Datelike, Duration, NaiveDate, SecondsFormat, Utc};
pub fn date(value: &Value) -> Result<DateTime<Utc>> {
    let date =
        DateTime::parse_from_rfc3339(string(value)?).map_err(|_| Error("BILLING_DATE_INVALID"))?;
    DateTime::from_timestamp_millis(date.timestamp_millis()).ok_or(Error("BILLING_DATE_INVALID"))
}
pub fn stamp(date: DateTime<Utc>) -> String {
    date.to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn anniversary(anchor: DateTime<Utc>, offset: i64, day: u32) -> Result<DateTime<Utc>> {
    if !(1..=31).contains(&day) {
        return Err(Error("BILLING_ANCHOR_INVALID"));
    }
    let month = i64::from(anchor.year()) * 12 + i64::from(anchor.month0()) + offset;
    let year = i32::try_from(month.div_euclid(12)).map_err(|_| Error("BILLING_DATE_INVALID"))?;
    let month = (month.rem_euclid(12) + 1) as u32;
    let (next_year, next_month) = if month == 12 {
        (year.checked_add(1).ok_or(Error("BILLING_DATE_INVALID"))?, 1)
    } else {
        (year, month + 1)
    };
    let last = NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .and_then(|d| d.pred_opt())
        .ok_or(Error("BILLING_DATE_INVALID"))?
        .day();
    Ok(NaiveDate::from_ymd_opt(year, month, day.min(last))
        .ok_or(Error("BILLING_DATE_INVALID"))?
        .and_time(anchor.time())
        .and_utc())
}
pub fn next_month(boundary: DateTime<Utc>, day: u32) -> Result<DateTime<Utc>> {
    anniversary(boundary, 1, day)
}
pub fn capture(start: DateTime<Utc>, end: DateTime<Utc>) -> Result<Value> {
    let day = start.day().max(end.day());
    if start >= end || next_month(start, day)? != end {
        return Err(Error("BILLING_ANCHOR_RECONCILIATION_REQUIRED"));
    }
    Ok(
        json!({"originalPeriodStart":stamp(start),"effectiveAt":stamp(end),"anchorDay":day,"nextRenewalAt":stamp(next_month(end,day)?)}),
    )
}
pub fn period(workspace: &str, now: DateTime<Utc>, source: &Value) -> Result<Value> {
    if crate::text::trim(workspace).is_empty() {
        return Err(Error("USAGE_WORKSPACE_REQUIRED"));
    }
    let (start, end) = match source["kind"].as_str() {
        Some("trial") => {
            let start = date(&source["trialStartedAt"])?;
            let end = start
                .checked_add_signed(Duration::days(14))
                .ok_or(Error("BILLING_DATE_INVALID"))?;
            if now < start || now >= end {
                return Err(Error("USAGE_TRIAL_OUTSIDE_PERIOD"));
            }
            (start, end)
        }
        Some("paid-monthly") => {
            let start = date(&source["currentPeriodStart"])?;
            let end = date(&source["currentPeriodEnd"])?;
            if start >= end || now < start || now >= end {
                return Err(Error("USAGE_PERIOD_RECONCILIATION_REQUIRED"));
            }
            (start, end)
        }
        _ => {
            let anchor = date(&source["workspaceCreatedAt"])?;
            if now < anchor {
                return Err(Error("USAGE_BEFORE_WORKSPACE"));
            }
            let mut months = i64::from(now.year() - anchor.year()) * 12 + i64::from(now.month0())
                - i64::from(anchor.month0());
            if anniversary(anchor, months, anchor.day())? > now {
                months -= 1;
            }
            (
                anniversary(anchor, months, anchor.day())?,
                anniversary(anchor, months + 1, anchor.day())?,
            )
        }
    };
    let start = stamp(start);
    let end = stamp(end);
    Ok(
        json!({"workspaceId":workspace,"start":start,"end":end,"key":serde_json::to_string(&json!(["forge.ai-usage-period",workspace,start,end])).unwrap()}),
    )
}
fn replacement(value: &Value) -> Result<Value> {
    let start = date(&value["originalPeriodStart"])?;
    let end = date(&value["effectiveAt"])?;
    let original = capture(start, end)?;
    let day = safe_integer(&value["anchorDay"], 1)?;
    let next = date(&value["nextRenewalAt"])?;
    let grace = date(&value["checkoutGraceEndsAt"])?;
    let paid = date(&value["paidAt"])?;
    if original["anchorDay"].as_u64() != Some(day)
        || date(&original["nextRenewalAt"])? != next
        || end.checked_add_signed(Duration::days(7)) != Some(grace)
    {
        return Err(Error("BILLING_ANCHOR_RECONCILIATION_REQUIRED"));
    }
    if paid < end || paid >= grace {
        return Err(Error("BILLING_REPLACEMENT_OUTSIDE_CHECKOUT_GRACE"));
    }
    let following = next_month(next, day as u32)?;
    Ok(
        json!({"usagePeriodStart":stamp(end),"usagePeriodEnd":stamp(next),"paidAt":stamp(paid),"originalAnchorDay":day,"alignedPeriodEnd":stamp(next),"followingPeriodEnd":stamp(following),"followUpRequired":next_month(next,next.day())?!=following,"grantsFreshPaidPool":false}),
    )
}
fn carryover(value: &Value, trial: bool) -> Result<Value> {
    let workspace = string(&value["workspaceId"])?;
    let created = date(&value["workspaceCreatedAt"])?;
    let now = date(&value["now"])?;
    let identity = &value[if trial {
        "redemptionId"
    } else {
        "sourcePeriodId"
    }];
    let identity = crate::contract::uuid(identity.clone()).map_err(|_| invalid())?;
    let end = if trial {
        let start = date(&value["trialStartedAt"])?;
        if start < created {
            return Err(Error("TRIAL_CARRYOVER_NOT_DUE"));
        }
        start
            .checked_add_signed(Duration::days(14))
            .ok_or(Error("TRIAL_CARRYOVER_NOT_DUE"))?
    } else {
        date(&value["paidAccessEndedAt"])?
    };
    if now < end {
        return Err(Error(if trial {
            "TRIAL_CARRYOVER_NOT_DUE"
        } else {
            "USAGE_DOWNGRADE_NOT_DUE"
        }));
    }
    let source = json!({"kind":"free","workspaceCreatedAt":stamp(created)});
    let target = period(workspace, end, &source)?;
    let current = period(workspace, now, &source)?;
    let settled = safe_integer(
        &value[if trial {
            "settledTrialMicros"
        } else {
            "settledPoolUsdMicros"
        }],
        0,
    )?;
    let reserved = safe_integer(
        &value[if trial {
            "reservedTrialMicros"
        } else {
            "reservedPoolUsdMicros"
        }],
        0,
    )?;
    let committed = safe(u128::from(settled) + u128::from(reserved))?;
    let key = serde_json::to_string(&json!([
        if trial {
            "forge.trial-expiry-capacity"
        } else {
            "forge.paid-to-free-capacity"
        },
        workspace,
        identity,
        target["key"]
    ]))
    .unwrap();
    let mut result = json!({"key":key,"targetPeriod":target,"appliesToCurrentFreePeriod":target["key"]==current["key"],"committedCapacityMicros":committed,"newAllowanceMicros":0,"billableMicros":0});
    if trial {
        result["settledCapacityMicros"] = json!(settled);
        result["reservedCapacityMicros"] = json!(reserved);
    }
    Ok(result)
}
pub fn evaluate(kind: &str, value: &Value) -> Result<Value> {
    match kind {
        "next-month" => {
            let day = safe_integer(&value["anchorDay"], 1)?;
            if day > 31 {
                return Err(Error("BILLING_ANCHOR_INVALID"));
            }
            Ok(json!(stamp(next_month(
                date(&value["boundary"])?,
                day as u32
            )?)))
        }
        "anchor" => capture(date(&value["start"])?, date(&value["end"])?),
        "replacement" => replacement(value),
        "period" => period(
            string(&value["workspaceId"])?,
            date(&value["now"])?,
            &value["source"],
        ),
        "trial-carryover" => carryover(value, true),
        "paid-carryover" => carryover(value, false),
        _ => Err(invalid()),
    }
}
