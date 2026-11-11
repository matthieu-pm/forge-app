//! PostgreSQL adapters targeting Forge's existing Drizzle-managed schema.

pub mod accounts;
pub mod api_keys;
pub mod authority;
pub mod commands;
pub mod database;
pub mod definitions;
pub mod desktop_auth;
pub mod documents;
pub mod files;
pub mod initiatives;
pub mod issues;
pub mod jobs;
pub mod joins;
pub mod members;
pub mod oauth;
pub mod planning;
pub mod profiles;
pub mod projects;
pub mod resource_policy;
pub mod security;
pub mod sla;
pub mod teams;
pub mod workspaces;
pub use database::Database;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("Profile editing is unavailable.")]
    ProfileDisabled,
    #[error("This profile changed in another session.")]
    ProfileConflict,
    #[error("The SLA policy changed.")]
    SlaPolicyConflict,
    #[error("A team or status condition is unavailable. Review the conditions and save again.")]
    SlaPolicyValidation,
    #[error("This interruption changed. Refresh the policy before classifying it.")]
    SlaReconciliationConflict,
    #[error(transparent)]
    Upload(#[from] forge_core::files::UploadError),
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
    #[error(transparent)]
    Team(#[from] forge_core::teams::TeamError),
    #[error("These preferences changed in another session.")]
    PreferenceConflict(Vec<String>),
    #[error("This document changed in another session.")]
    DocumentConflict,
    #[error("The shared resource board changed in another session.")]
    ResourceConflict,
    #[error("{0}")]
    Planning(&'static str),
    #[error("{0}")]
    DefinitionConflict(&'static str),
    #[error("{0}")]
    IssueValidation(&'static str),
    #[error("These issues changed in another session.")]
    IssueEditConflict,
    #[error("{0}")]
    IssueRejected(&'static str),
    #[error("The comment changed in another session.")]
    CommentConflict,
    #[error("Sign in with your existing method before linking this provider.")]
    AccountNotLinked,
    #[error("Database operation failed.")]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Recovery(#[from] forge_core::journal::JournalError),
}

pub mod saved_views;
pub mod team_resources;

pub mod product_state;

pub mod imports;
pub mod preferences;
