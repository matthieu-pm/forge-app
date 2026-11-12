use super::{Clock, Error, coerce_date, hash};
use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use forge_core::billing::{calendar::stamp, money::ECB_REFERENCE_URL};
use regex::Regex;
use serde_json::{Value, json};
use std::{sync::LazyLock, time::Duration};
pub const FEED_LIMIT: usize = 64 * 1024;
pub struct FeedResponse {
    pub status: u16,
    pub body: Option<Vec<u8>>,
}
#[async_trait]
pub trait Feed: Send + Sync {
    async fn read(&self) -> Result<FeedResponse, Error>;
}
pub struct HttpFeed(reqwest::Client);
impl HttpFeed {
    pub fn new() -> Result<Self, Error> {
        Ok(Self(
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
                .timeout(Duration::from_secs(10))
                .build()
                .map_err(|_| Error("BILLING_FX_SOURCE_UNAVAILABLE"))?,
        ))
    }
}
#[async_trait]
impl Feed for HttpFeed {
    async fn read(&self) -> Result<FeedResponse, Error> {
        let mut response = self
            .0
            .get(ECB_REFERENCE_URL)
            .header("accept", "application/xml, text/xml")
            .header("cache-control", "no-cache")
            .send()
            .await
            .map_err(|_| Error("BILLING_FX_SOURCE_UNAVAILABLE"))?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Ok(FeedResponse { status, body: None });
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| Error("BILLING_FX_SOURCE_UNAVAILABLE"))?
        {
            if bytes.len() + chunk.len() > FEED_LIMIT {
                return Err(Error("BILLING_FX_FEED_INVALID"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(FeedResponse {
            status,
            body: Some(bytes),
        })
    }
}
static DATES: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<Cube[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+time=['"]([0-9]{4}-[0-9]{2}-[0-9]{2})['"][\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*>((?s:.)*?)</Cube>"#).unwrap()
});
static DOLLARS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"<Cube[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+currency=['"]USD['"][\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+rate=['"]([^'"]+)['"][\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*/>"#).unwrap()
});
static ENTITY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<!DOCTYPE|<!ENTITY").unwrap());
static ENVELOPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"</gesmes:Envelope>[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*$").unwrap()
});
static DECIMAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:0|[1-9][0-9]{0,7})(?:\.[0-9]{1,8})?$").unwrap());
pub async fn fetch(feed: &dyn Feed, clock: &Clock) -> Result<Value, Error> {
    let response = feed.read().await?;
    if !(200..300).contains(&response.status) || response.body.is_none() {
        return Err(Error("BILLING_FX_SOURCE_UNAVAILABLE"));
    }
    // The source clock is read after the complete bounded response is consumed.
    parse_clock(&response.body.unwrap(), clock.as_ref())
}
pub fn parse(bytes: &[u8], observed: DateTime<Utc>) -> Result<Value, Error> {
    parse_clock(bytes, &|| observed)
}
fn parse_clock(bytes: &[u8], clock: &dyn Fn() -> DateTime<Utc>) -> Result<Value, Error> {
    if bytes.len() > FEED_LIMIT {
        return Err(Error("BILLING_FX_FEED_INVALID"));
    }
    let decoded = std::str::from_utf8(bytes).map_err(|_| Error("INVALID_BILLING_INPUT"))?;
    let xml = decoded.strip_prefix('\u{feff}').unwrap_or(decoded);
    let dates: Vec<_> = DATES.captures_iter(xml).collect();
    let dollars: Vec<_> = DOLLARS.captures_iter(xml).collect();
    if ENTITY.is_match(xml)
        || !xml.contains("http://www.ecb.int/vocabulary/2002-08-01/eurofxref")
        || dates.len() != 1
        || dollars.len() != 1
        || !dates[0][2].contains(dollars[0].get(0).unwrap().as_str())
        || !ENVELOPE.is_match(xml)
    {
        return Err(Error("BILLING_FX_FEED_INVALID"));
    }
    let observed = clock();
    let reference = &dates[0][1];
    let rate = &dollars[0][1];
    let reference_time = coerce_date(Some(&json!(format!("{reference}T00:00:00Z"))));
    if reference_time.is_none_or(|at| {
        at.timestamp_millis() > observed.timestamp_millis()
            || observed.timestamp_millis() - at.timestamp_millis() > 7 * 86_400_000
    }) || number(rate) <= 0.0
    {
        return Err(Error("BILLING_FX_RATE_UNAVAILABLE_FOR_USAGE"));
    }
    // Keep schema rejection after feed freshness checks, matching the owning
    // adapter (including rolled-over invalid calendar dates).
    if NaiveDate::parse_from_str(reference, "%Y-%m-%d").is_err() || !DECIMAL.is_match(rate) {
        return Err(Error("INVALID_BILLING_INPUT"));
    }
    let mut identity = json!({"source":"ecb-daily-reference","sourceUrl":ECB_REFERENCE_URL,"referenceDate":reference,"observedAt":stamp(observed),"usdPerEur":rate});
    identity["id"] = json!(hash(&identity));
    Ok(identity)
}
fn number(value: &str) -> f64 {
    let raw = forge_core::text::trim(value);
    if raw.is_empty() {
        return 0.;
    }
    for (prefix, base) in [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ] {
        if let Some(digits) = raw.strip_prefix(prefix) {
            return u64::from_str_radix(digits, base)
                .map(|n| n as f64)
                .unwrap_or(f64::NAN);
        }
    }
    raw.parse().unwrap_or(f64::NAN)
}
