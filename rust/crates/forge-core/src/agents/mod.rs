//! Agent protocols and decisions shared by hosted and local execution adapters.
pub mod approval;
pub mod capabilities;
pub mod contracts;
pub mod diagnostics;
pub mod eve;
pub mod files;
pub mod models;
pub mod policy;
pub mod providers;
pub mod routing;
pub mod runtime;
pub mod sandbox;
pub mod tokens;
pub mod tools;
pub const RUNTIMES: &[&str] = &["eve", "codex", "claude"];
pub const EFFORTS: &[&str] = &["none", "minimal", "low", "medium", "high", "xhigh", "max"];
pub const EXECUTIONS: &[&str] = &["forge-native", "external-agent"];
pub const LOCALITIES: &[&str] = &["local-only", "server-capable"];
pub const BILLING: &[&str] = &[
    "forge-managed",
    "subscription",
    "token-plan",
    "pay-as-you-go",
];
pub const PROVIDERS: &[&str] = &[
    "openai",
    "anthropic",
    "google",
    "minimax",
    "mistral",
    "xai",
    "deepseek",
    "kimi",
    "custom-openai",
    "custom-anthropic",
];
pub const RISKS: &[&str] = &["read", "reversible-write", "important-write", "destructive"];
pub const EVENTS: &[&str] = &[
    "run.created",
    "run.started",
    "run.routing-resolved",
    "run.usage",
    "progress.note",
    "assistant.delta",
    "assistant.message",
    "tool.started",
    "tool.completed",
    "tool.failed",
    "code.started",
    "code.output",
    "code.completed",
    "file.search.started",
    "file.search.completed",
    "file.read",
    "file.patch.proposed",
    "file.patch.applied",
    "approval.requested",
    "approval.resolved",
    "artifact.created",
    "run.waiting",
    "run.cancelled",
    "run.failed",
    "run.completed",
];
