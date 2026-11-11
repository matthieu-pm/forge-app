//! Forge's shared domain behavior. No network, database, or UI dependencies.

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub mod actor;
pub mod canonical;
pub mod comments;
mod contract;
pub mod cycles;
pub mod definitions;
pub mod documents;
pub mod features;
pub mod initiatives;
pub mod issue_query;
pub mod issues;
pub mod journal;
pub mod planning;
pub mod projects;
pub mod security;
pub mod security_commands;
pub mod subscription;
pub mod teams;
pub mod text;
pub mod visibility;

pub mod json;

pub mod saved_views;
pub mod team_resources;

pub mod product_state;

pub mod preferences;

pub mod files;
pub mod imports;
pub mod jobs;
pub mod profiles;
pub mod sla;
