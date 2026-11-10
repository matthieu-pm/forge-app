//! PostgreSQL adapters targeting Forge's existing Drizzle-managed schema.

pub mod accounts;
pub mod api_keys;
pub mod authority;
pub mod commands;
pub mod database;
pub mod desktop_auth;
pub mod joins;
pub mod members;
pub mod oauth;
pub mod security;
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
    #[error("The resource was not found.")]
    NotFound,
    #[error("This setting requires the {0:?} plan.")]
    PlanRequired(forge_core::security::WorkspacePlan),
    #[error("The domain is already registered.")]
    DomainTaken,
    #[error("The domain verification TXT record is missing or expired.")]
    DomainUnverified,
    #[error("Sign in with your existing method before linking this provider.")]
    AccountNotLinked,
    #[error("Database operation failed.")]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Recovery(#[from] forge_core::journal::JournalError),
}
