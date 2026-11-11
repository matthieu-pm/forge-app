//! Monitored retention of completed product data and expired publication drafts.
mod product;
pub(crate) use crate::operational_health::heartbeat;
pub use product::{DesktopBlobs, Error, run_product};
use serde::Serialize;
#[derive(Debug, Serialize)]
pub struct Report {
    pub count: usize,
    pub failures: usize,
}
impl Report {
    pub fn successful(&self) -> bool {
        self.failures == 0
    }
}
