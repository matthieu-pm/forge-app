//! Native runtime orchestration. Untrusted programs execute only through an
//! explicit isolated Sandbox adapter; this library has no local-process fallback.
pub mod auth;
pub mod callback;
pub mod configuration;
pub mod context;
pub use forge_core::agents::sandbox as contracts;
pub mod engine;
pub mod execution;
pub mod framework;
pub mod host;
pub mod http;
pub mod journal;
pub mod model;
pub mod sandbox;
pub mod tools;
pub mod vercel;
pub mod web;
pub mod worker;
pub mod workspace;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct Error(pub &'static str);
pub type Result<T> = std::result::Result<T, Error>;
