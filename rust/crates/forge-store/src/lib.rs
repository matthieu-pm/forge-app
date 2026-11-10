//! PostgreSQL adapters targeting Forge's existing Drizzle-managed schema.

pub mod accounts;
pub mod authority;
pub mod commands;
pub mod database;
pub mod workspaces;
pub use database::Database;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("Authenticated session required.")]
    Unauthenticated,
    #[error("You do not have permission to perform this action.")]
    Forbidden,
    #[error("Verify your email address before using Forge.")]
    EmailNotVerified,
    #[error("No active workspace is available.")]
    NoActiveWorkspace,
    #[error("The API key rate limit has been exceeded.")]
    RateLimited,
    #[error("The command key was already used with different input.")]
    CommandReused,
    #[error("The command outcome requires reconciliation before retry.")]
    CommandAmbiguous,
    #[error("The command result is no longer available; its effect cannot be repeated.")]
    CommandResultUnavailable,
    #[error("Invalid command input.")]
    InvalidInput,
    #[error("The resource conflicts with existing state.")]
    Conflict,
    #[error("Database operation failed.")]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Recovery(#[from] forge_core::journal::JournalError),
}
