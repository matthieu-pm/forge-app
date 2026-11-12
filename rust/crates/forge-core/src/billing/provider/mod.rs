//! Provider observations remain untrusted until their complete billing contract
//! has been verified. A hosted checkout redirect is never payment evidence.
use super::{Result, invalid, money};
use chrono::{DateTime, Utc};
use serde_json::Value;
pub mod catalog;
pub mod orders;
pub mod refund;
pub mod subscription;
pub use catalog::catalog;
pub use subscription::snapshot;

pub(super) fn instant(value: &Value) -> Result<DateTime<Utc>> {
    if !value.as_str().is_some_and(|s| money::INSTANT.is_match(s)) {
        return Err(invalid());
    }
    super::calendar::date(value).map_err(|_| invalid())
}
