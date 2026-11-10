//! Forge's shared domain behavior. No network, database, or UI dependencies.

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod actor;
pub mod canonical;
pub mod features;
pub mod journal;
pub mod visibility;
