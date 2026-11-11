//! Trusted agent persistence adapters. Application services must bind the live
//! actor, workspace and run before calling these stores. They are not HTTP APIs.
//! Mutations share the existing schema's constraints and deletion journal.

pub mod approvals;
pub mod events;
pub mod invocations;
pub mod preferences;
pub mod records;
pub mod runs;
pub mod threads;

pub use records::*;
